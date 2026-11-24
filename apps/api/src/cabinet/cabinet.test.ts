import { createDb, createPool, withPrincipal, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  LEVEL_PRESETS,
  CABINET_LIMITS,
  type AlsoIn,
  type CabinetLevel,
  type CabinetCounts,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetPreview,
  type CabinetView,
  type DocumentPage,
  type FolderFilter,
  type Tokens,
} from '@fdv/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asArranged, createHarness, type Harness } from '../test-harness.js';

/**
 * My cabinet (0.9.0, C1; 0097), through the API as each member of a
 * household, and in the database as the application role.
 *
 * Each person's layout is theirs alone. A folder is a saved question of
 * GET /documents, checked by the list's own parser; what it holds, and how
 * many, come from the list's own rules — so nothing is revealed that its
 * person may not open: somebody else's Only me, a sensitive paper kept from
 * them, or what sits in the Trash.
 */

type Person = 'owner' | 'adult' | 'teen' | 'viewer';

/** UUIDs, which a negative pattern must never match by chance, taken out first. */
const unUuid = (s: string) =>
  s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

const SECRETS = {
  /** Olive's Only me tax form. */
  ownerPrivate: 'OLIVE-ONLY-ME-TAX-C1',
  /** Sam's Only me bank statement. */
  adultPrivate: 'SAM-ONLY-ME-BANK-C1',
  /** Tia's own passport: sensitive, so Only me from the start (H1a). */
  teenPassport: 'TIA-PASSPORT-C1',
  /** Tia's medical record, kept to the adults: sensitive, and not hers to see. */
  adultsMedical: 'TIA-MEDICAL-ADULTS-C1',
  /** In the Trash. */
  trashed: 'TRASHED-TAX-C1',
};

describe.skipIf(!testAdminUrl())('my cabinet', () => {
  let h: Harness;
  const people = {} as Record<Person, Tokens>;
  const accounts = {} as Record<Person, string>;
  const ids = {} as Record<string, string>;
  let thisYear = 0;
  const statements: string[] = [];
  let listening = false;
  let lastYear = 0;

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
      remoteAddress: `10.97.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as T;
  };
  const member = (who: Person) => people[who].member_id;

  /** A drawing by levels, afresh: over no arrangement at all. */
  const preview = (who: Person, levels: readonly CabinetLevel[]) =>
    ok<CabinetPreview>(
      call(who, 'POST', '/api/v1/cabinet/preview', {
        levels,
        layout: { levels: null, cabinets: [] },
      }),
    );
  const mine = (who: Person) => ok<CabinetView>(call(who, 'GET', '/api/v1/cabinet'));
  const save = (who: Person, layout: CabinetLayout, version: number) =>
    call(who, 'PUT', '/api/v1/cabinet', { layout: asArranged(layout), version });
  const saved = async (who: Person, layout: CabinetLayout) => {
    const at = await mine(who);
    return ok<CabinetView>(save(who, layout, at.version));
  };
  const counts = (who: Person) =>
    ok<CabinetCounts>(call(who, 'GET', '/api/v1/cabinet/counts')).then((c) => c.counts);
  const alsoIn = (who: Person, id: string) => call(who, 'GET', `/api/v1/documents/${id}/also-in`);
  /** A folder's documents, as the table lists them: every page's worth, the total and the titles. */
  const listed = async (who: Person, filter: FolderFilter) => {
    const q = new URLSearchParams({ sort: 'title', limit: '200' });
    for (const [k, v] of Object.entries(filter)) {
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
    }
    const page = await ok<DocumentPage>(call(who, 'GET', `/api/v1/documents?${q.toString()}`));
    return { total: page.total, titles: page.items.map((d) => d.title) };
  };
  /** A layout of one cabinet, one drawer, and these folders. */
  const oneDrawer = (folders: Array<Omit<CabinetFolder, 'hidden'> & { hidden?: boolean }>) => ({
    levels: null,
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
  const foldersOf = (layout: CabinetLayout) =>
    layout.cabinets.flatMap((c) =>
      c.drawers.flatMap((d) => d.folders.map((f) => ({ path: [c.name, d.name, f.name], f }))),
    );

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 10_000,
      // Each statement the API runs, while a test listens.
      log: (e) => {
        if (listening) statements.push(e.query.sql);
      },
    });
    people.owner = await h.setup({ display_name: 'Olive Khan' });
    people.adult = await h.join(people.owner, {
      name: 'Sam Khan',
      email: 'cabinet-sam@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia Khan',
      email: 'cabinet-tia@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Vic Khan',
      email: 'cabinet-vic@example.test',
      role: 'viewer',
    });
    for (const who of Object.keys(people) as Person[]) {
      accounts[who] = (await ok<{ account_id: string }>(call(who, 'GET', '/api/v1/me'))).account_id;
    }
    // The years as the database's calendar has them: the year a paper with
    // no issue date was added in.
    const admin = createPool(h.adminUrl, 1);
    try {
      const { rows } = await admin.query<{ y: number }>(
        'select extract(year from now()::date)::int as y',
      );
      thisYear = rows[0]?.y as number;
    } finally {
      await admin.end();
    }
    lastYear = thisYear - 1;
    const day = (y: number, md: string) => ({ date: `${y}-${md}`, precision: 'day' });
    const file = async (who: Person, body: object) =>
      (await ok<{ id: string }>(call(who, 'POST', '/api/v1/documents', body))).id;
    ids.ownerTaxLast = await file('owner', {
      title: 'Tax return last year',
      type_key: 'tax_return',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(lastYear, '04-10'),
    });
    ids.ownerTaxThis = await file('owner', {
      title: 'W-2 this year',
      type_key: 'tax_form',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(thisYear, '01-02'),
    });
    ids.ownerPrivate = await file('owner', {
      title: SECRETS.ownerPrivate,
      type_key: 'tax_form',
      owner_member_id: member('owner'),
      visibility: 'private',
      issued: day(thisYear, '01-03'),
    });
    // No issue date: dated by the day it was added.
    ids.adultBill = await file('adult', {
      title: 'Sam’s water bill',
      type_key: 'utility_bill',
      owner_member_id: member('adult'),
      household_owned: false,
      visibility: 'household',
    });
    ids.adultPrivate = await file('adult', {
      title: SECRETS.adultPrivate,
      type_key: 'bank_statement',
      owner_member_id: member('adult'),
      visibility: 'private',
      issued: day(lastYear, '06-30'),
    });
    ids.adultsMedical = await file('owner', {
      title: SECRETS.adultsMedical,
      type_key: 'medical_record',
      owner_member_id: member('teen'),
      visibility: 'adults',
      issued: day(lastYear, '09-01'),
    });
    // Tia's own sensitive paper starts Only me (H1a).
    ids.teenPassport = await file('teen', {
      title: SECRETS.teenPassport,
      type_key: 'passport',
      owner_member_id: member('teen'),
      issued: day(lastYear, '03-03'),
    });
    ids.teenDiploma = await file('owner', {
      title: 'Tia’s school report',
      type_key: 'diploma',
      owner_member_id: member('teen'),
      visibility: 'household',
      issued: day(thisYear, '01-05'),
    });
    ids.householdBill = await file('owner', {
      title: 'Council tax bill',
      type_key: 'utility_bill',
      household_owned: true,
      visibility: 'household',
      issued: day(lastYear, '11-11'),
    });
    // No kind, nobody's yet: no topic, so in no folder of a drawing.
    ids.unsorted = await file('owner', { title: 'A scan to sort', visibility: 'household' });
    ids.note = await file('owner', {
      title: 'A note',
      type_key: 'note',
      notes: 'Remember the boiler',
      visibility: 'household',
    });
    ids.trashed = await file('owner', {
      title: SECRETS.trashed,
      type_key: 'tax_form',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(thisYear, '01-04'),
    });
    expect((await call('owner', 'DELETE', `/api/v1/documents/${ids.trashed}`)).statusCode).toBe(
      204,
    );
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  it('says it can', async () => {
    const caps = await ok<{ features: { cabinets?: boolean } }>(
      call('owner', 'GET', '/api/v1/capabilities'),
    );
    expect(caps.features.cabinets).toBe(true);
  });

  it('has nothing saved until it is', async () => {
    expect(await mine('viewer')).toEqual({ layout: null, version: 0, updated_at: null });
    expect(await ok<CabinetCounts>(call('viewer', 'GET', '/api/v1/cabinet/counts'))).toEqual({
      version: 0,
      counts: {},
    });
  });

  describe('Arrange by', () => {
    it('by person, then topic, then year: the caller first, every year newest first', async () => {
      const p = await preview('owner', ['person', 'topic', 'year']);
      expect(p.layout.levels).toEqual(['person', 'topic', 'year']);
      // What older apps read (deprecated): always null.
      expect(p.layout.arranged_by).toBeNull();
      const shape = p.layout.cabinets.map((c) => ({
        name: c.name,
        drawers: c.drawers.map((d) => ({
          name: d.name,
          folders: d.folders.map((f) => `${f.name}:${p.counts[f.id]}`),
        })),
      }));
      expect(shape).toEqual([
        // Olive's tax: this year's two (her Only me one among them, hers to
        // see), last year's one; never the one in the Trash.
        {
          name: 'Olive',
          drawers: [{ name: 'Tax', folders: [`${thisYear}:2`, `${lastYear}:1`] }],
        },
        { name: 'Sam', drawers: [{ name: 'Bills & utilities', folders: [`${thisYear}:1`] }] },
        {
          name: 'Tia',
          // In the vault's order of topics.
          drawers: [
            { name: 'Medical', folders: [`${lastYear}:1`] },
            { name: 'Education', folders: [`${thisYear}:1`] },
          ],
        },
        {
          name: 'The household',
          drawers: [{ name: 'Bills & utilities', folders: [`${lastYear}:1`] }],
        },
      ]);
      // Sam's Only me statement and Tia's passport are nowhere in hers.
      expect(JSON.stringify(shape)).not.toMatch(/Financial|Identity/);
      // The scan with no topic is left out; the note and the Trash are not counted at all.
      expect(p.documents).toBe(8);
      expect(p.left_out).toBe(1);
      // Each folder asks the list's own question for what it counted.
      const tax = p.layout.cabinets[0]?.drawers[0]?.folders[0];
      expect(tax?.filter).toEqual({
        notes: 'exclude',
        member_id: member('owner'),
        category: 'tax',
        dated_from: `${thisYear}-01-01`,
        dated_to: `${thisYear}-12-31`,
      });
    });

    it('by topic, then year, then person: a Tax cabinet with a drawer for each year', async () => {
      const p = await preview('owner', ['topic', 'year', 'person']);
      const tax = p.layout.cabinets.find((c) => c.name === 'Tax');
      expect(
        tax?.drawers.map((d) => [d.name, d.folders.map((f) => `${f.name}:${p.counts[f.id]}`)]),
      ).toEqual([
        [String(thisYear), ['Olive:2']],
        [String(lastYear), ['Olive:1']],
      ]);
      const bills = p.layout.cabinets.find((c) => c.name === 'Bills & utilities');
      expect(bills?.drawers.map((d) => [d.name, d.folders.map((f) => f.name)])).toEqual([
        [String(thisYear), ['Sam']],
        [String(lastYear), ['The household']],
      ]);
      expect(p.layout.cabinets.map((c) => c.name)).not.toContain('Financial');
    });

    it('by person, then kind: one cabinet, a drawer for each person', async () => {
      const p = await preview('owner', ['person', 'kind']);
      expect(p.layout.cabinets).toHaveLength(1);
      expect(p.layout.cabinets[0]?.name).toBe('My cabinet');
      const drawers = p.layout.cabinets[0]?.drawers ?? [];
      expect(drawers.map((d) => d.name)).toEqual(['Olive', 'Sam', 'Tia', 'The household']);
      expect(drawers[0]?.folders.map((f) => `${f.name}:${p.counts[f.id]}`)).toEqual([
        'Tax return:1',
        'W-2 / 1099 / tax form:2',
      ]);
      expect(drawers[0]?.folders[0]?.filter).toEqual({
        notes: 'exclude',
        member_id: member('owner'),
        type_key: 'tax_return',
      });
      expect(p.left_out).toBe(1);
    });

    it('is drawn from what each person can see: never another’s Only me, nor a sensitive paper kept from them', async () => {
      // Tia: her passport and her school report; not the medical record kept to the adults.
      const teen = await preview('teen', ['person', 'topic', 'year']);
      const flat = foldersOf(teen.layout).map((x) => x.path.join(' › '));
      expect(flat).toContain(`Tia › Identity › ${lastYear}`);
      expect(flat).toContain(`Tia › Education › ${thisYear}`);
      expect(flat.join('\n')).not.toMatch(/Medical/);
      // Olive's Only me is not counted in hers: one of this year's two.
      const olive = foldersOf(teen.layout).find(
        (x) => x.path.join(' › ') === `Olive › Tax › ${thisYear}`,
      );
      expect(olive && teen.counts[olive.f.id]).toBe(1);
      // Sam: his Only me statement, and no Only me of Olive's.
      const adult = await preview('adult', ['topic', 'year', 'person']);
      const adultFlat = foldersOf(adult.layout).map((x) => x.path.join(' › '));
      expect(adultFlat).toContain(`Financial › ${lastYear} › Sam`);
      const tax = foldersOf(adult.layout).find(
        (x) => x.path.join(' › ') === `Tax › ${thisYear} › Olive`,
      );
      expect(tax && adult.counts[tax.f.id]).toBe(1);
      // The viewer: nothing kept to the adults.
      const viewer = await preview('viewer', ['person', 'topic', 'year']);
      expect(
        foldersOf(viewer.layout)
          .map((x) => x.path.join(' › '))
          .join('\n'),
      ).not.toMatch(/Medical|Financial|Identity/);
      // No title reaches a drawing at all.
      for (const p of [teen, adult, viewer]) {
        const body = unUuid(JSON.stringify(p));
        for (const secret of Object.values(SECRETS)) expect(body).not.toContain(secret);
      }
    });

    it('holds, saved, exactly what it counted: each folder’s count, and its list, the same', async () => {
      for (const who of ['owner', 'adult', 'teen', 'viewer'] as Person[]) {
        for (const by of LEVEL_PRESETS) {
          const p = await preview(who, by);
          await saved(who, p.layout);
          const got = await counts(who);
          expect(got, `${who} ${by.join(' › ')}`).toEqual(p.counts);
          for (const { f } of foldersOf(p.layout)) {
            expect((await listed(who, f.filter)).total, `${who} ${by.join(' › ')} ${f.name}`).toBe(
              p.counts[f.id],
            );
          }
        }
      }
    });

    it('refuses a way it does not know, and levels that are not 2 to 5, each once', async () => {
      const r = await call('owner', 'POST', '/api/v1/cabinet/preview', { arrange_by: 'colour' });
      expect(r.statusCode).toBe(422);
      for (const levels of [['year'], ['year', 'year'], ['year', 'colour'], []]) {
        const wrong = await call('owner', 'POST', '/api/v1/cabinet/preview', { levels });
        expect(wrong.statusCode, JSON.stringify(levels)).toBe(422);
      }
    });

    it('still takes an older vault’s way, for its levels', async () => {
      const p = await ok<CabinetPreview>(
        call('owner', 'POST', '/api/v1/cabinet/preview', { arrange_by: 'person_kind' }),
      );
      expect(p.layout.levels).toEqual(['person', 'kind']);
    });
  });

  describe('counts and contents, from the side of whoever must not see', () => {
    /** Folders that ask for exactly where each secret would be. */
    const nosy = () =>
      oneDrawer([
        {
          id: 'olive-tax',
          name: 'Olive’s tax',
          filter: { member_id: member('owner'), category: 'tax' },
        },
        { id: 'sam-all', name: 'Sam’s', filter: { member_id: member('adult') } },
        { id: 'tia-all', name: 'Tia’s', filter: { member_id: member('teen') } },
        { id: 'medical', name: 'Medical', filter: { category: 'medical' } },
        { id: 'identity', name: 'Identity', filter: { category: 'identity' } },
        { id: 'private', name: 'Only me', filter: { visibility: 'private' } },
        { id: 'sensitive', name: 'Sensitive', filter: { sensitive: 'yes' } },
        {
          id: 'this-year',
          name: 'This year',
          filter: { dated_from: `${thisYear}-01-01`, dated_to: `${thisYear}-12-31` },
        },
      ]);

    it('counts only what each person may open', async () => {
      const expected: Record<Person, Record<string, number>> = {
        // Olive: her Only me tax form; not Sam's statement, nor Tia's passport.
        owner: {
          'olive-tax': 3,
          'sam-all': 1,
          'tia-all': 2,
          medical: 1,
          identity: 0,
          private: 1,
          // Tax papers, the medical record, the school report and the scan
          // with no kind are sensitive (0090): her own Only me among them.
          sensitive: 6,
          // Her two tax forms, Sam's bill (added this year), Tia's report,
          // the scan and the note (added this year).
          'this-year': 6,
        },
        // Sam: not Olive's Only me, nor Tia's passport.
        adult: {
          'olive-tax': 2,
          'sam-all': 2,
          'tia-all': 2,
          medical: 1,
          identity: 0,
          private: 1,
          sensitive: 6,
          'this-year': 5,
        },
        // Tia: her passport, never the medical record kept to the adults.
        teen: {
          'olive-tax': 2,
          'sam-all': 1,
          'tia-all': 2,
          medical: 0,
          identity: 1,
          private: 1,
          sensitive: 5,
          'this-year': 5,
        },
        // The viewer: Everyone's alone.
        viewer: {
          'olive-tax': 2,
          'sam-all': 1,
          'tia-all': 1,
          medical: 0,
          identity: 0,
          private: 0,
          sensitive: 4,
          'this-year': 5,
        },
      };
      for (const who of Object.keys(expected) as Person[]) {
        await saved(who, nosy());
        expect(await counts(who), who).toEqual(expected[who]);
      }
    });

    it('lists, in each folder, no title its person may not open', async () => {
      const kept: Record<Person, string[]> = {
        owner: [SECRETS.adultPrivate, SECRETS.teenPassport, SECRETS.trashed],
        adult: [SECRETS.ownerPrivate, SECRETS.teenPassport, SECRETS.trashed],
        teen: [SECRETS.ownerPrivate, SECRETS.adultPrivate, SECRETS.adultsMedical, SECRETS.trashed],
        viewer: [
          SECRETS.ownerPrivate,
          SECRETS.adultPrivate,
          SECRETS.teenPassport,
          SECRETS.adultsMedical,
          SECRETS.trashed,
        ],
      };
      for (const who of Object.keys(kept) as Person[]) {
        for (const { f } of foldersOf(nosy())) {
          const got = await listed(who, f.filter);
          for (const secret of kept[who])
            expect(got.titles, `${who} ${f.name}`).not.toContain(secret);
        }
        const body = unUuid(JSON.stringify([await mine(who), await counts(who)]));
        for (const secret of Object.values(SECRETS)) expect(body).not.toContain(secret);
      }
    });

    it('says a document is also in a folder only to whoever may open it', async () => {
      await saved('teen', nosy());
      // Not hers to see: there is no such document, for her.
      for (const id of [ids.adultsMedical, ids.ownerPrivate, ids.adultPrivate]) {
        const r = await alsoIn('teen', id as string);
        expect(r.statusCode).toBe(404);
        for (const secret of Object.values(SECRETS)) expect(unUuid(r.body)).not.toContain(secret);
      }
      const own = await ok<AlsoIn>(alsoIn('teen', ids.teenPassport as string));
      expect(own.items.map((i) => i.id).sort()).toEqual(
        ['identity', 'private', 'sensitive', 'tia-all'].sort(),
      );
      expect(own.items.find((i) => i.id === 'identity')?.path).toEqual([
        'Mine',
        'Drawer',
        'Identity',
      ]);
      // Sam may not open Olive's Only me, nor Tia's passport.
      await saved('adult', nosy());
      expect((await alsoIn('adult', ids.ownerPrivate as string)).statusCode).toBe(404);
      expect((await alsoIn('adult', ids.teenPassport as string)).statusCode).toBe(404);
      // Something that is not an id at all.
      expect((await alsoIn('adult', 'not-an-id')).statusCode).toBe(404);
    });

    it('puts nothing in the Trash in a folder, and leaves hidden folders out', async () => {
      await saved(
        'owner',
        oneDrawer([
          { id: 'tax', name: 'Tax', filter: { category: 'tax' } },
          { id: 'hidden', name: 'Hidden', filter: { category: 'tax' }, hidden: true },
        ]),
      );
      expect(await counts('owner')).toEqual({ tax: 3 });
      expect(await ok<AlsoIn>(alsoIn('owner', ids.ownerTaxThis as string))).toEqual({
        items: [{ id: 'tax', name: 'Tax', path: ['Mine', 'Drawer', 'Tax'] }],
      });
      // The owner sees what is in her Trash, and it is in no folder.
      expect(await ok<AlsoIn>(alsoIn('owner', ids.trashed as string))).toEqual({ items: [] });
    });

    it('counts a status, worked out, as the table does', async () => {
      await saved(
        'owner',
        oneDrawer([{ id: 'needs', name: 'Needs details', filter: { status: 'needs_info' } }]),
      );
      const got = await counts('owner');
      expect(got.needs).toBe((await listed('owner', { status: 'needs_info' })).total);
      const also = await ok<AlsoIn>(alsoIn('owner', ids.unsorted as string));
      expect(also.items.map((i) => i.id)).toEqual(
        (await listed('owner', { status: 'needs_info' })).titles.includes('A scan to sort')
          ? ['needs']
          : [],
      );
    });
  });

  describe('a folder’s question', () => {
    it('is the list’s own, checked by its parser: anything else is refused, and nothing saved', async () => {
      const before = await mine('adult');
      const refused: Array<Record<string, unknown>> = [
        { sort: 'title' },
        { limit: '5' },
        { cursor: 'x' },
        { deleted: 'true' },
        { purge_requested: 'true' },
        { updated_since: new Date().toISOString() },
        { colour: 'red' },
        { member_id: 'not-a-person' },
        { status: 'lost' },
        { visibility: 'everyone' },
        { sensitive: 'maybe' },
        { issued_from: `${thisYear}-02-30` },
        { dated_from: `${thisYear}-12-31`, dated_to: `${thisYear}-01-01` },
        { collection_id: 'not-a-collection' },
        { essential: 'perhaps' },
        {
          member_id: Array.from(
            { length: 51 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          ).join(','),
        },
      ];
      for (const filter of refused) {
        const r = await save(
          'adult',
          oneDrawer([{ id: 'f', name: 'Folder', filter: filter }]),
          before.version,
        );
        expect(r.statusCode, JSON.stringify(filter)).toBe(422);
        expect(r.json()).toMatchObject({ error: { code: 'validation_failed' } });
      }
      expect(await mine('adult')).toEqual(before);
    });

    it('is refused when too big', async () => {
      const before = await mine('adult');
      const tags = Array.from({ length: 50 }, (_, i) => `${'long tag '.repeat(10)}${i}`);
      const r = await save(
        'adult',
        oneDrawer([{ id: 'f', name: 'Folder', filter: { tag: tags } }]),
        before.version,
      );
      expect(r.statusCode).toBe(422);
      expect(r.json<{ error: { message: string } }>().error.message).toMatch(/too much/);
    });

    it('may ask where originals are kept only of whoever may', async () => {
      const filter = { location: 'Study cabinet' };
      const viewer = await mine('viewer');
      const r = await save(
        'viewer',
        oneDrawer([{ id: 'f', name: 'Study', filter }]),
        viewer.version,
      );
      expect(r.statusCode).toBe(422);
      const owner = await mine('owner');
      expect(
        (await save('owner', oneDrawer([{ id: 'f', name: 'Study', filter }]), owner.version))
          .statusCode,
      ).toBe(200);
    });

    it('is valid in what holds it too: ids, names and sizes', async () => {
      const at = (await mine('adult')).version;
      const folder = (i: number) => ({ id: `f${i}`, name: `F${i}`, hidden: false, filter: {} });
      const bad: unknown[] = [
        oneDrawer([
          { id: 'same', name: 'A', filter: {} },
          { id: 'same', name: 'B', filter: {} },
        ]),
        oneDrawer([{ id: 'has space', name: 'A', filter: {} }]),
        oneDrawer([{ id: 'f', name: '   ', filter: {} }]),
        oneDrawer([{ id: 'f', name: 'x'.repeat(CABINET_LIMITS.name + 1), filter: {} }]),
        { levels: null, cabinets: [], extra: true },
        {
          levels: null,
          cabinets: Array.from({ length: 4 }, (_, c) => ({
            id: `c${c}`,
            name: `C${c}`,
            hidden: false,
            drawers: Array.from({ length: 2 }, (_, d) => ({
              id: `c${c}d${d}`,
              name: `D${d}`,
              hidden: false,
              folders: Array.from({ length: 130 }, (_, f) => folder(c * 1000 + d * 200 + f)),
            })),
          })),
        },
      ];
      for (const layout of bad) {
        const r = await call('adult', 'PUT', '/api/v1/cabinet', {
          layout: asArranged(layout as CabinetLayout),
          version: at,
        });
        expect(r.statusCode, r.body.slice(0, 200)).toBe(422);
      }
    });
  });

  describe('saving', () => {
    it('is made to the version last read, and refused (409) when it changed meanwhile', async () => {
      const layout = oneDrawer([{ id: 'a', name: 'A', filter: {} }]);
      const at = await mine('viewer');
      const first = await ok<CabinetView>(save('viewer', layout, at.version));
      expect(first.version).toBe(at.version + 1);
      // A second window, saving to the version it read before.
      const stale = await save('viewer', layout, at.version);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: 'conflict' } });
      // Two at once, to the same version: one is saved, one refused.
      const both = await Promise.all([
        save('viewer', oneDrawer([{ id: 'b', name: 'B', filter: {} }]), first.version),
        save('viewer', oneDrawer([{ id: 'c', name: 'C', filter: {} }]), first.version),
      ]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const now = await mine('viewer');
      expect(now.version).toBe(first.version + 1);
      const won = both.find((r) => r.statusCode === 200)?.json() as CabinetView;
      expect(now.layout).toEqual(won.layout);
    });

    it('first saves of two windows at once: one made, one refused', async () => {
      // Remove Tia's, as the database's owner, to start again from none.
      const admin = createPool(h.adminUrl, 1);
      try {
        await admin.query('delete from cabinet_layout where member_id = $1', [member('teen')]);
      } finally {
        await admin.end();
      }
      const both = await Promise.all([
        save('teen', oneDrawer([{ id: 'b', name: 'B', filter: {} }]), 0),
        save('teen', oneDrawer([{ id: 'c', name: 'C', filter: {} }]), 0),
      ]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect((await mine('teen')).version).toBe(1);
    });

    it('is each person’s own: nobody reads or overwrites another’s through the API', async () => {
      await saved('owner', oneDrawer([{ id: 'olive', name: 'OLIVE-FOLDER-C1', filter: {} }]));
      await saved('adult', oneDrawer([{ id: 'sam', name: 'SAM-FOLDER-C1', filter: {} }]));
      expect(JSON.stringify(await mine('adult'))).not.toContain('OLIVE-FOLDER-C1');
      expect(JSON.stringify(await mine('owner'))).not.toContain('SAM-FOLDER-C1');
      expect(Object.keys(await counts('adult'))).toEqual(['sam']);
    });
  });

  describe('in the database, as the application role', () => {
    let one: Db;
    const principal = (who: Person) => ({
      householdId: people[who].household_id,
      accountId: accounts[who],
      memberId: people[who].member_id,
      role: people[who].role,
    });
    beforeAll(async () => {
      one = createDb(createPool(h.appUrl, 1));
      await saved('owner', oneDrawer([{ id: 'olive', name: 'Olive’s', filter: {} }]));
      await saved('adult', oneDrawer([{ id: 'sam', name: 'Sam’s', filter: {} }]));
    });
    afterAll(async () => {
      await one.destroy();
    });

    it('gives each person their own row alone: an owner reads nobody else’s', async () => {
      for (const who of ['owner', 'adult', 'teen', 'viewer'] as Person[]) {
        const rows = await withPrincipal(one, principal(who), (trx) =>
          trx.selectFrom('cabinet_layout').select('member_id').execute(),
        );
        expect(
          rows.every((r) => r.member_id === member(who)),
          who,
        ).toBe(true);
      }
    });

    it('lets nobody write another’s: not an update, a delete, an insert or an upsert', async () => {
      const olive = member('owner');
      const hh = people.owner.household_id;
      const updated = await withPrincipal(one, principal('adult'), async (trx) =>
        Number(
          (
            await trx
              .updateTable('cabinet_layout')
              .set({ layout: JSON.stringify({ levels: null, cabinets: [] }) })
              .where('member_id', '=', olive)
              .executeTakeFirst()
          ).numUpdatedRows,
        ),
      );
      expect(updated).toBe(0);
      const deleted = await withPrincipal(one, principal('adult'), async (trx) =>
        Number(
          (await trx.deleteFrom('cabinet_layout').where('member_id', '=', olive).executeTakeFirst())
            .numDeletedRows,
        ),
      );
      expect(deleted).toBe(0);
      // Another's row written new, or over theirs (PG 16: the conflicting
      // row's UPDATE rule is asked too).
      await expect(
        withPrincipal(one, principal('teen'), (trx) =>
          trx
            .insertInto('cabinet_layout')
            .values({ household_id: hh, member_id: member('viewer'), layout: '{}' })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        withPrincipal(one, principal('adult'), (trx) =>
          trx
            .insertInto('cabinet_layout')
            .values({ household_id: hh, member_id: olive, layout: '{}' })
            .onConflict((oc) =>
              oc
                .columns(['household_id', 'member_id'])
                .doUpdateSet({ layout: '{"taken":true}' })
                .where('cabinet_layout.version', '>', 0),
            )
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // And an owner writes nobody else's either.
      const ownerUpdated = await withPrincipal(one, principal('owner'), async (trx) =>
        Number(
          (
            await trx
              .updateTable('cabinet_layout')
              .set({ version: sql<number>`version + 1` })
              .where('member_id', '=', member('adult'))
              .executeTakeFirst()
          ).numUpdatedRows,
        ),
      );
      expect(ownerUpdated).toBe(0);
      // Theirs, as it was.
      expect(JSON.stringify(await mine('owner'))).toContain('Olive’s');
      expect(JSON.stringify(await mine('adult'))).toContain('Sam’s');
      // Their own upsert, made to their own row, is theirs to make.
      await withPrincipal(one, principal('adult'), (trx) =>
        trx
          .insertInto('cabinet_layout')
          .values({
            household_id: hh,
            member_id: member('adult'),
            layout: JSON.stringify({
              levels: ['topic', 'year', 'person'],
              cabinets: [
                { id: 'm', name: 'Mine 1', hidden: false, drawers: [], drawn: { value: 'm' } },
              ],
            }),
          })
          .onConflict((oc) =>
            oc
              .columns(['household_id', 'member_id'])
              .doUpdateSet({
                layout: JSON.stringify({
                  levels: ['topic', 'year', 'person'],
                  cabinets: [
                    { id: 'm', name: 'Mine 2', hidden: false, drawers: [], drawn: { value: 'm' } },
                  ],
                }),
              })
              .where('cabinet_layout.version', '>', 0),
          )
          .execute(),
      );
      const names = (await mine('adult')).layout?.cabinets.map((x) => x.name);
      expect(names).toContain('Mine 2');
      expect(names).not.toContain('Mine 1');
    });

    it('gives a caller who says nothing, or a share link, no row', async () => {
      const admin = createPool(h.appUrl, 1);
      try {
        for (const actor of ['', 'link', 'upload', 'anonymous']) {
          const client = await admin.connect();
          try {
            await client.query('begin');
            await client.query(
              `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true),
                      set_config('app.member_id', $3, true)`,
              [people.owner.household_id, actor, member('owner')],
            );
            const { rows } = await client.query<{ n: number }>(
              'select count(*)::int as n from cabinet_layout',
            );
            await client.query('rollback');
            expect(rows[0]?.n, actor).toBe(0);
          } finally {
            client.release();
          }
        }
      } finally {
        await admin.end();
      }
    });
  });

  describe('the review’s checks (C1)', () => {
    /** One drawer of `n` folders, each made by `make`. */
    const many = (n: number, make: (i: number) => FolderFilter) =>
      oneDrawer(
        Array.from({ length: n }, (_, i) => ({ id: `f${i}`, name: `F${i}`, filter: make(i) })),
      );
    const STATUSES = ['expired', 'expiring_soon', 'needs_info', 'active', 'valid'];

    it('counts many folders that ask a status in a bounded number of statements, each as the table would', async () => {
      const layout = many(150, (i) => ({
        status: STATUSES[i % STATUSES.length] as string,
        ...(i % 2 === 0 ? { member_id: member('owner') } : { category: 'tax' }),
      }));
      await saved('owner', layout);
      statements.length = 0;
      listening = true;
      const got = await counts('owner');
      listening = false;
      // A reading of every row the owner may see for each hundred folders, and
      // a kind's lookup at most for each kind: never a statement a folder.
      // Besides them, one question whatever the layout (C4): whether papers
      // came from folders the cabinet has none for yet.
      const flag = statements.filter((q) => /source_folder/.test(q) && /exists/.test(q));
      expect(flag).toHaveLength(1);
      // The same readings give what the whole cabinet holds (19 Nov 2026).
      const reads = statements.filter((q) => /from document d/.test(q) && !flag.includes(q));
      expect(reads.length).toBeLessThanOrEqual(2);
      expect(statements.length).toBeLessThan(40);
      // And each the table's own total.
      for (const { f } of foldersOf(layout).slice(0, 10)) {
        expect(got[f.id], f.name).toBe((await listed('owner', f.filter)).total);
      }
    });

    it('keeps folders that ask a status to 200 a cabinet', async () => {
      const at = await mine('owner');
      const r = await save(
        'owner',
        many(201, () => ({ status: 'expired' })),
        at.version,
      );
      expect(r.statusCode).toBe(422);
      expect(r.json<{ error: { code: string } }>().error.code).toBe(
        'cabinet_too_many_status_folders',
      );
    });

    it('measures a layout by its bytes: a near-limit one in Chinese saves, one past it is refused', async () => {
      // Three tags of 400 characters, each three bytes: about 3,600 bytes a folder.
      const words = (i: number) => [0, 1, 2].map((t) => `${'文件柜'.repeat(132)}${i}${t}`);
      const at = await mine('adult');
      const near = await save(
        'adult',
        many(130, (i) => ({ tag: words(i) })),
        at.version,
      );
      expect(near.statusCode, near.body.slice(0, 200)).toBe(200);
      const past = many(200, (i) => ({ tag: words(i) }));
      // Under the limit by its characters, past it by its bytes.
      expect(JSON.stringify(past).length).toBeLessThan(CABINET_LIMITS.layout_bytes);
      const r = await save('adult', past, near.json<CabinetView>().version);
      expect(r.statusCode).toBe(422);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('cabinet_too_big');
    });

    it('names a drawing’s parts within a name’s length, a long name cut, and says what is wrong by its own code', async () => {
      const long = (last: string) => `Bartholomew ${'Fitzwilliam-'.repeat(8)}${last}`.slice(0, 120);
      for (const name of [long('Alpha'), long('Beta')]) {
        const made = await ok<{ id: string }>(
          call('owner', 'POST', '/api/v1/members', { display_name: name }),
        );
        await ok(
          call('owner', 'POST', '/api/v1/documents', {
            title: `${name.slice(-5)} report`,
            type_key: 'diploma',
            owner_member_id: made.id,
            visibility: 'household',
          }),
        );
      }
      const p = await preview('owner', ['person', 'kind']);
      const names = (p.layout.cabinets[0]?.drawers ?? []).map((d) => d.name);
      const cut = names.filter((n) => n.startsWith('Bartholomew'));
      expect(cut).toHaveLength(2);
      for (const n of cut) {
        expect([...n].length).toBeLessThanOrEqual(CABINET_LIMITS.name);
        expect(n.endsWith('…')).toBe(true);
      }
      // Saved as drawn.
      await saved('owner', p.layout);
      // A name refused says so by its own code.
      const at = await mine('owner');
      const bad = await save(
        'owner',
        oneDrawer([{ id: 'f', name: 'x'.repeat(CABINET_LIMITS.name + 1), filter: {} }]),
        at.version,
      );
      expect(bad.json<{ error: { code: string } }>().error.code).toBe('cabinet_name_too_long');
      const dup = await save(
        'owner',
        oneDrawer([
          { id: 'same', name: 'A', filter: {} },
          { id: 'same', name: 'B', filter: {} },
        ]),
        at.version,
      );
      expect(dup.json<{ error: { code: string } }>().error.code).toBe('cabinet_node_id');
    });

    it('lists a folder in the order of the date a paper is about, newest first', async () => {
      const got = await ok<DocumentPage>(
        call(
          'owner',
          'GET',
          `/api/v1/documents?sort=dated&direction=desc&limit=200&member_id=${member('owner')}`,
        ),
      );
      const days = got.items.map((d) => d.issued?.date ?? d.created_at.slice(0, 10));
      expect(days).toEqual([...days].sort().reverse());
    });
  });

  it('the list asks the date a paper is about: issued, else added', async () => {
    const got = await listed('owner', {
      dated_from: `${thisYear}-01-01`,
      dated_to: `${thisYear}-12-31`,
      member_id: member('adult'),
    });
    expect(got.titles).toEqual(['Sam’s water bill']);
    const last = await listed('owner', {
      dated_from: `${lastYear}-01-01`,
      dated_to: `${lastYear}-12-31`,
      category: 'tax',
    });
    expect(last.titles).toEqual(['Tax return last year']);
  });
});
