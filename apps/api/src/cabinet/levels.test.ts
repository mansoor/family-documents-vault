import { testAdminUrl } from '@fdv/db/testing';
import {
  CABINET_LEVELS,
  dividerLevelsOf,
  nodeLevels,
  type Cabinet,
  type CabinetCounts,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetLevel,
  type CabinetPreview,
  type CabinetView,
  type DocumentPage,
  type FolderContents,
  type Tokens,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Cabinet levels (0.9.0-dev.90), through the API as each member of a
 * household: a cabinet drawn by levels in any order, a cabinet's own
 * arrangement below it, levels 4 and 5 as dividers worked out when a
 * folder opens, redraws that keep names, pins and ranges, cabinets arranged
 * by hand kept beside the drawn ones, and growing by the new levels — every
 * count from the side of whoever must not see: somebody else's Only me,
 * and a paper kept to the adults from a teen.
 */

type Person = 'owner' | 'adult' | 'teen';

const SECRETS = {
  /** Olive's own bank statement, Only me. */
  onlyMe: 'OLIVE-ONLY-ME-STATEMENT-L',
  /** Tia's medical letter, kept to the adults. */
  adults: 'TIA-ADULTS-LETTER-L',
};

/** Every ordered pick of `k` levels. */
function orders(k: number): CabinetLevel[][] {
  if (k === 0) return [[]];
  return orders(k - 1).flatMap((o) =>
    CABINET_LEVELS.filter((l) => !o.includes(l)).map((l) => [...o, l]),
  );
}

describe.skipIf(!testAdminUrl())('cabinet levels you choose, and per cabinet', () => {
  let h: Harness;
  const people = {} as Record<Person, Tokens>;
  const ids = {} as Record<string, string>;
  const kinds = new Map<string, { label: string; category: string | null }>();
  let nth = 0;
  const year = new Date().getUTCFullYear();

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
      remoteAddress: `10.96.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as T;
  };
  const member = (who: Person) => people[who].member_id;
  const mine = (who: Person) => ok<CabinetView>(call(who, 'GET', '/api/v1/cabinet'));
  const save = (who: Person, layout: CabinetLayout, version: number, extra: object = {}) =>
    call(who, 'PUT', '/api/v1/cabinet', { layout, version, ...extra });
  const saved = async (who: Person, layout: CabinetLayout) => {
    const at = await mine(who);
    return ok<CabinetView>(save(who, layout, at.version));
  };
  const preview = (who: Person, body: object) =>
    ok<CabinetPreview>(call(who, 'POST', '/api/v1/cabinet/preview', body));
  /** A drawing afresh, over no arrangement. */
  const fresh = (who: Person, levels: CabinetLevel[]) =>
    preview(who, { levels, layout: { levels: null, cabinets: [] } });
  const counts = (who: Person) => ok<CabinetCounts>(call(who, 'GET', '/api/v1/cabinet/counts'));
  const opened = (who: Person, folder: string) =>
    ok<FolderContents>(call(who, 'GET', `/api/v1/cabinet/folders/${folder}`));
  const behind = (who: Person, folder: string, divider: string) =>
    call(
      who,
      'GET',
      `/api/v1/cabinet/folders/${folder}/documents?divider=${encodeURIComponent(divider)}&limit=200`,
    );
  const titlesBehind = async (who: Person, folder: string, divider: string) =>
    (await ok<DocumentPage>(behind(who, folder, divider))).items.map((d) => d.title);
  /** How many the table gives a reader for a question: what a folder or divider must hold. */
  const tableTotal = async (who: Person, filter: Record<string, string>) => {
    const q = new URLSearchParams({ sort: 'title', limit: '1', ...filter });
    return (await ok<DocumentPage>(call(who, 'GET', `/api/v1/documents?${q.toString()}`))).total;
  };
  /** A divider's key as the table's own question, beside its folder's. */
  const askedBy = (key: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const seg of key.split('/')) {
      const [level, value = ''] = seg.split(':');
      if (level === 'kind') out.type_key = value;
      if (level === 'topic') out.category = value;
      if (level === 'year')
        Object.assign(out, { dated_from: `${value}-01-01`, dated_to: `${value}-12-31` });
    }
    return out;
  };
  /** Every divider of a folder holds what the table gives the reader for it, and they add up. */
  const addsUp = async (who: Person, folder: CabinetFolder) => {
    const c = await opened(who, folder.id);
    const base = folder.filter as Record<string, string>;
    for (const d of c.dividers) {
      if (d.key === 'all') continue;
      expect(d.count, `${who} ${d.key}`).toBe(
        await tableTotal(who, { ...base, ...askedBy(d.key) }),
      );
    }
    expect(c.dividers.reduce((n, d) => n + d.count, 0)).toBe(c.total);
    expect(c.total).toBe((await counts(who)).counts[folder.id]);
    return c;
  };
  const file = async (who: Person, body: object) =>
    (await ok<{ id: string }>(call(who, 'POST', '/api/v1/documents', body))).id;
  const day = (date: string) => ({ date, precision: 'day' });
  const folders = (l: CabinetLayout) =>
    l.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders.map((f) => ({ c, d, f }))));
  /** A cabinet arranged by hand: one drawer, these folders. */
  const byHand = (id: string, fs: CabinetFolder[]): Cabinet => ({
    id,
    name: 'Kept by hand',
    hidden: false,
    drawers: [{ id: `${id}-d`, name: 'Drawer', hidden: false, folders: fs }],
  });

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    people.owner = await h.setup({ display_name: 'Olive Khan' });
    people.adult = await h.join(people.owner, {
      name: 'Sam Khan',
      email: 'levels-sam@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia Khan',
      email: 'levels-tia@example.test',
      role: 'teen',
    });
    const types = await ok<{
      items: Array<{ key: string; label: string; category: string | null }>;
    }>(call('owner', 'GET', '/api/v1/document-types?all=true'));
    for (const t of types.items) kinds.set(t.key, { label: t.label, category: t.category });
    const paper = (who: Person, title: string, type_key: string | null, date: string, more = {}) =>
      file(who, {
        title,
        ...(type_key ? { type_key } : {}),
        owner_member_id: member(who === 'adult' ? 'adult' : who === 'teen' ? 'teen' : 'owner'),
        visibility: 'household',
        issued: day(date),
        ...more,
      });
    ids.bankLast = await paper(
      'owner',
      'Olive bank last year',
      'bank_statement',
      `${year - 1}-03-01`,
    );
    ids.bankNow = await paper('owner', 'Olive bank this year', 'bank_statement', `${year}-02-01`);
    ids.payNow = await paper('owner', 'Olive pay this year', 'pay_statement', `${year}-01-15`);
    ids.taxLast = await paper('owner', 'Olive tax last year', 'tax_return', `${year - 1}-04-10`);
    ids.onlyMe = await paper('owner', SECRETS.onlyMe, 'bank_statement', `${year}-05-01`, {
      visibility: 'private',
    });
    ids.samBank = await paper('adult', 'Sam bank this year', 'bank_statement', `${year}-03-01`);
    ids.tiaDiploma = await paper('owner', 'Tia diploma', 'diploma', `${year - 2}-06-01`, {
      owner_member_id: member('teen'),
    });
    ids.tiaAdults = await paper('owner', SECRETS.adults, 'medical_record', `${year - 3}-10-05`, {
      owner_member_id: member('teen'),
      visibility: 'adults',
    });
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  it('says it can', async () => {
    const caps = await ok<{ features: { cabinet_levels?: boolean } }>(
      call('owner', 'GET', '/api/v1/capabilities'),
    );
    expect(caps.features.cabinet_levels).toBe(true);
  });

  it('draws in every order of levels, each folder holding exactly what it counted, for each person', async () => {
    for (const who of ['owner', 'teen'] as Person[]) {
      for (const levels of [...orders(2), ...orders(3), ...orders(4).slice(0, 6)]) {
        const p = await fresh(who, levels);
        expect(p.layout.levels).toEqual(levels);
        expect(p.size).toMatchObject({ over: null, folders: folders(p.layout).length });
        for (const { f } of folders(p.layout)) {
          expect(f.dividers).toEqual({ levels: dividerLevelsOf(levels), ranges: [] });
        }
        await saved(who, p.layout);
        const got = await counts(who);
        expect(got.counts, `${who} ${levels.join(' › ')}`).toEqual(p.counts);
      }
    }
  }, 120_000);

  it('divides a folder by the fourth level when it opens: a step for each kind, never a paper the reader can’t see', async () => {
    const levels: CabinetLevel[] = ['person', 'topic', 'year', 'kind'];
    const financial = kinds.get('bank_statement')?.category ?? '';
    const question = {
      member_id: member('owner'),
      category: financial,
      dated_from: `${year}-01-01`,
      dated_to: `${year}-12-31`,
    };
    for (const who of ['owner', 'adult', 'teen'] as Person[]) {
      const p = await fresh(who, levels);
      await saved(who, p.layout);
      const folder = folders(p.layout).find((x) =>
        Object.entries(question).every(([k, v]) => (x.f.filter as Record<string, string>)[k] === v),
      )?.f;
      if (!folder) {
        expect(await tableTotal(who, question), who).toBe(0);
        continue;
      }
      expect(folder.dividers).toEqual({ levels: ['kind'], ranges: [] });
      const c = await addsUp(who, folder);
      for (const d of c.dividers) expect(d.key).toMatch(/^(all|kind:.*)$/);
      const titles = (
        await Promise.all(c.dividers.map((d) => titlesBehind(who, folder.id, d.key)))
      ).flat();
      // Olive's own Only me statement: hers alone.
      expect(titles.includes(SECRETS.onlyMe), who).toBe(who === 'owner');
    }
    // Hers: her two statements this year behind one divider, named as the kind is.
    const owner = (await mine('owner')).layout as CabinetLayout;
    const hers = folders(owner).find((x) =>
      Object.entries(question).every(([k, v]) => (x.f.filter as Record<string, string>)[k] === v),
    )?.f as CabinetFolder;
    const c = await opened('owner', hers.id);
    const bank = c.dividers.find((d) => d.path?.[0]?.key === 'kind:bank_statement');
    expect(bank?.count).toBe(2);
    expect(bank?.path?.[0]).toEqual({
      level: 'kind',
      key: 'kind:bank_statement',
      name: kinds.get('bank_statement')?.label,
    });
  });

  it('divides a folder by two levels as one flat list an older app shows, and asks only its own steps', async () => {
    const hand: CabinetLayout = {
      levels: null,
      cabinets: [
        byHand('two', [
          {
            id: 'olive-all',
            name: 'Everything of Olive’s',
            hidden: false,
            filter: { member_id: member('owner'), notes: 'exclude' },
            dividers: { levels: ['kind', 'year'], ranges: [] },
          },
          {
            id: 'tia-all',
            name: 'Everything of Tia’s',
            hidden: false,
            filter: { member_id: member('teen'), notes: 'exclude' },
            dividers: { levels: ['topic', 'kind'], ranges: [] },
          },
        ]),
      ],
    };
    const bankLabel = kinds.get('bank_statement')?.label ?? '';
    for (const who of ['owner', 'adult', 'teen'] as Person[]) {
      await saved(who, hand);
      const c = await opened(who, 'olive-all');
      const keys = c.dividers.map((d) => d.key);
      expect(keys).toContain(`kind:bank_statement/year:${year}`);
      expect(keys).toContain(`kind:bank_statement/year:${year - 1}`);
      expect(keys.some((k) => k.includes(SECRETS.onlyMe))).toBe(false);
      const leaf = c.dividers.find((d) => d.key === `kind:bank_statement/year:${year}`);
      // One flat leaf, named by its steps: what an older phone shows.
      expect(leaf?.name).toBe(`${bankLabel} · ${year}`);
      expect(leaf?.count).toBe(
        await tableTotal(who, { member_id: member('owner'), ...askedBy(leaf?.key ?? '') }),
      );
      // Pay statements and tax returns are each of one year: that year passed over.
      if (who === 'owner') {
        expect(keys).toContain('kind:pay_statement');
        expect(keys).toContain('kind:tax_return');
      }
      // Each divider is the table's own count, and they add up to the folder.
      await addsUp(who, hand.cabinets[0]?.drawers[0]?.folders[0] as CabinetFolder);
      // A step the folder is not divided by, or out of its order, is none of its.
      for (const wrong of [
        'topic:financial',
        `year:${year}/kind:bank_statement`,
        'person:',
        'rest',
      ]) {
        expect((await behind(who, 'olive-all', wrong)).statusCode, `${who} ${wrong}`).toBe(404);
      }
      // A step passed over may still be asked: what it held is all of it.
      expect(await titlesBehind(who, 'olive-all', `year:${year - 1}`)).toEqual(
        expect.arrayContaining(['Olive bank last year', 'Olive tax last year']),
      );
      // Tia's: the adults' letter is never counted for her.
      const tia = await opened(who, 'tia-all');
      const medicalTopic = kinds.get('medical_record')?.category ?? 'medical';
      const medical = tia.dividers.find((d) =>
        d.path?.some((s) => s.key === 'kind:medical_record' || s.key === `topic:${medicalTopic}`),
      );
      expect(medical === undefined, who).toBe(who === 'teen');
      expect(JSON.stringify(tia).includes(SECRETS.adults)).toBe(false);
    }
  });

  it('redraws nothing for levels 4 and 5 alone, and keeps pins through a redraw of levels 2 and 3', async () => {
    const drawn = await fresh('owner', ['person', 'topic', 'year']);
    const financial = kinds.get('bank_statement')?.category ?? '';
    const target = (l: CabinetLayout) =>
      folders(l).find(
        (x) =>
          x.f.filter.member_id === member('owner') &&
          x.f.filter.category === financial &&
          x.f.filter.dated_from === `${year}-01-01`,
      )?.f as CabinetFolder;
    const was = target(drawn.layout);
    was.name = 'Money this year';
    was.dividers = {
      levels: [],
      ranges: [{ name: 'Spring', from: `${year}-03-01`, to: `${year}-05-31` }],
    };
    await saved('owner', drawn.layout);
    await ok(
      call('owner', 'POST', `/api/v1/cabinet/folders/${was.id}/pins`, {
        document_ids: [ids.payNow],
      }),
    );
    // Hidden after its pin: kept, and still holding it.
    const withHidden = (await mine('owner')).layout as CabinetLayout;
    target(withHidden).hidden = true;
    await saved('owner', withHidden);

    // Kind as a fourth level: no folder redrawn, every part as it was but its divider levels.
    const four = await preview('owner', { levels: ['person', 'topic', 'year', 'kind'] });
    expect(four.counts).toEqual({});
    const now = target(four.layout);
    expect(now).toMatchObject({ id: was.id, name: 'Money this year', hidden: true });
    expect(now.dividers).toEqual({ levels: ['kind'], ranges: was.dividers.ranges });
    expect(folders(four.layout).map((x) => x.f.id)).toEqual(folders(withHidden).map((x) => x.f.id));
    await saved('owner', four.layout);

    // Year and Topic swapped: the same folder, by its question, keeps its id, pin, hiding and ranges.
    const swapped = await preview('owner', { levels: ['person', 'year', 'topic', 'kind'] });
    const again = target(swapped.layout);
    expect(again).toMatchObject({ id: was.id, hidden: true });
    expect(again.dividers?.ranges).toEqual(was.dividers.ranges);
    // Its name was given at the folder's level then (Year); Topic's is drawn now.
    expect(again.name).not.toBe('Money this year');
    const kept = await saved('owner', swapped.layout);
    expect((await counts('owner')).pins?.[was.id]).toBe(1);
    // Saved as drawn: the vault reads it back the same.
    expect(kept.layout).toEqual(swapped.layout);
  });

  it('gives one cabinet its own order below it, redrawing it alone, and the default again', async () => {
    const drawn = await fresh('owner', ['topic', 'year', 'person']);
    const base = await saved('owner', drawn.layout);
    const financial = kinds.get('bank_statement')?.category ?? '';
    const fin = base.layout?.cabinets.find((c) => c.drawn?.value === financial) as Cabinet;
    const own = await preview('owner', {
      levels: ['topic', 'year', 'person'],
      cabinet: { id: fin.id, levels: ['person', 'kind'] },
    });
    const ownFin = own.layout.cabinets.find((c) => c.id === fin.id) as Cabinet;
    expect(ownFin.drawn).toEqual({ value: financial, levels: ['person', 'kind'] });
    expect(ownFin.drawers.map((d) => d.folders.every((f) => f.filter.type_key))).not.toContain(
      false,
    );
    for (const f of ownFin.drawers.flatMap((d) => d.folders)) {
      expect(f.dividers).toEqual({ levels: ['year'], ranges: [] });
    }
    // Every other cabinet is as it was.
    expect(own.layout.cabinets.filter((c) => c.id !== fin.id)).toEqual(
      base.layout?.cabinets.filter((c) => c.id !== fin.id),
    );
    const withOwn = await saved('owner', own.layout);
    expect(withOwn.layout?.cabinets.find((c) => c.id === fin.id)?.drawn?.levels).toEqual([
      'person',
      'kind',
    ]);
    // Its counts are the table's.
    const got = await counts('owner');
    for (const f of ownFin.drawers.flatMap((d) => d.folders))
      expect(got.counts[f.id]).toBe(own.counts[f.id]);
    // The default again.
    const back = await preview('owner', {
      levels: ['topic', 'year', 'person'],
      cabinet: { id: fin.id, levels: null },
    });
    const again = back.layout.cabinets.find((c) => c.id === fin.id) as Cabinet;
    expect(again.drawn).toEqual({ value: financial });
    expect(again.drawers.map((d) => d.name)).toEqual(fin.drawers.map((d) => d.name));
    // Never the cabinet's own level inside it; never over other levels; never on two levels.
    for (const ask of [
      { levels: ['topic', 'year', 'person'], cabinet: { id: fin.id, levels: ['topic', 'kind'] } },
      { levels: ['topic', 'person', 'year'], cabinet: { id: fin.id, levels: ['person', 'kind'] } },
      { levels: ['topic', 'year', 'person'], cabinet: { id: 'nope', levels: ['person', 'kind'] } },
    ]) {
      const r = await call('owner', 'POST', '/api/v1/cabinet/preview', ask);
      expect([r.statusCode, r.json<{ error: { code: string } }>().error.code]).toEqual([
        422,
        'cabinet_levels',
      ]);
    }
    const wrong = structuredClone(withOwn.layout) as CabinetLayout;
    (wrong.cabinets.find((c) => c.id === fin.id) as Cabinet).drawn = {
      value: financial,
      levels: ['topic', 'kind'],
    };
    const refused = await save('owner', wrong, withOwn.version);
    expect([refused.statusCode, refused.json<{ error: { code: string } }>().error.code]).toEqual([
      422,
      'cabinet_levels',
    ]);
    const twoLevels = { ...withOwn.layout, levels: ['topic', 'person'] } as CabinetLayout;
    const refusedTwo = await save('owner', twoLevels, withOwn.version);
    expect(refusedTwo.json<{ error: { code: string } }>().error.code).toBe('cabinet_levels');
  });

  it('keeps cabinets arranged by hand beside the drawn ones, never redrawn or grown', async () => {
    const hand = byHand('hand', [
      {
        id: 'hand-olive',
        name: 'Olive’s',
        hidden: false,
        // It holds every paper of Olive's: the drawing grows beside it all the same.
        filter: { member_id: member('owner'), notes: 'exclude' },
      },
    ]);
    await saved('owner', { levels: null, cabinets: [hand] });
    const p = await preview('owner', { levels: ['person', 'topic', 'year'] });
    expect(p.layout.cabinets.find((c) => c.id === 'hand')).toEqual(hand);
    expect(p.layout.cabinets.filter((c) => c.drawn).length).toBeGreaterThan(0);
    // The drawn ones before it, with none drawn yet.
    expect(p.layout.cabinets.at(-1)?.id).toBe('hand');
    await saved('owner', p.layout);
    // A new paper: grown into the drawn cabinets, never the one by hand.
    await file('owner', {
      title: 'Olive bill next year',
      type_key: 'utility_bill',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(`${year + 1}-01-10`),
    });
    const grown = (await mine('owner')).layout as CabinetLayout;
    expect(grown.cabinets.find((c) => c.id === 'hand')).toEqual(hand);
    const bill = folders(grown).find(
      (x) => x.f.filter.type_key === undefined && x.f.filter.dated_from === `${year + 1}-01-01`,
    );
    expect(bill?.c.drawn?.value).toBe(member('owner'));
    expect(bill?.f.dividers).toEqual({ levels: [], ranges: [] });
  });

  it('grows a cabinet by its own levels, and a fourth level as dividers', async () => {
    const drawn = await fresh('owner', ['topic', 'year', 'person', 'kind']);
    const base = await saved('owner', drawn.layout);
    const financial = kinds.get('bank_statement')?.category ?? '';
    const fin = base.layout?.cabinets.find((c) => c.drawn?.value === financial) as Cabinet;
    const own = await preview('owner', {
      levels: ['topic', 'year', 'person', 'kind'],
      cabinet: { id: fin.id, levels: ['person', 'kind'] },
    });
    await saved('owner', own.layout);
    await file('adult', {
      title: 'Sam pay next year',
      type_key: 'pay_statement',
      owner_member_id: member('adult'),
      visibility: 'household',
      issued: day(`${year + 1}-02-01`),
    });
    const grown = (await mine('owner')).layout as CabinetLayout;
    const payCategory = kinds.get('pay_statement')?.category ?? '';
    const cab = grown.cabinets.find((c) => c.drawn?.value === payCategory) as Cabinet;
    const added = folders({ levels: null, cabinets: [cab] }).find(
      (x) => x.f.filter.member_id === member('adult') && x.f.filter.type_key === 'pay_statement',
    );
    if (payCategory === financial) {
      // By Financial's own levels: Sam's drawer, a Pay statement folder, by year inside.
      expect(added?.d.name).toBe('Sam');
      expect(added?.f.dividers).toEqual({ levels: ['year'], ranges: [] });
    } else {
      expect(added).toBeUndefined();
      const yearly = folders({ levels: null, cabinets: [cab] }).find(
        (x) =>
          x.f.filter.member_id === member('adult') && x.f.filter.dated_from === `${year + 1}-01-01`,
      );
      expect(yearly?.f.dividers).toEqual({ levels: ['kind'], ranges: [] });
    }
    // Its count is the table's own.
    const made = (added ??
      folders({ levels: null, cabinets: [cab] }).find(
        (x) =>
          x.f.filter.member_id === member('adult') && x.f.filter.dated_from === `${year + 1}-01-01`,
      )) as { f: CabinetFolder };
    expect((await counts('owner')).counts[made.f.id]).toBe(
      await tableTotal('owner', made.f.filter as Record<string, string>),
    );
  });

  it('describes a drawing past a cabinet’s limits, and refuses it only as it is saved', async () => {
    const many = (n: number, prefix: string): CabinetFolder[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `${prefix}${i}`,
        name: `Folder ${i}`,
        hidden: false,
        filter: { tag: `t${prefix}${i}` },
      }));
    const big: CabinetLayout = {
      levels: null,
      cabinets: [
        {
          id: 'big',
          name: 'Big',
          hidden: false,
          drawers: [0, 1, 2, 3].map((d) => ({
            id: `big-${d}`,
            name: `Drawer ${d}`,
            hidden: false,
            folders: many(250, `f${d}-`),
          })),
        },
      ],
    };
    // A thousand folders of one's own, as a cabinet may hold: the drawing beside them, past it.
    const p = await preview('owner', { levels: ['person', 'kind'], layout: big });
    expect(p.size.over).toBe('cabinet_too_big');
    expect(p.size.folders).toBeGreaterThan(1000);
    expect(p.size.biggest_drawer?.folders).toBe(250);
    const at0 = await mine('owner');
    const r = await save('owner', p.layout, at0.version);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('cabinet_too_big');
    // An arrangement sent to draw over that is past them already: refused, not drawn.
    const past = structuredClone(big);
    past.cabinets[0]?.drawers.push({
      id: 'big-more',
      name: 'More',
      hidden: false,
      folders: many(10, 'more-'),
    });
    const refused = await call('owner', 'POST', '/api/v1/cabinet/preview', {
      levels: ['person', 'kind'],
      layout: past,
    });
    expect([refused.statusCode, refused.json<{ error: { code: string } }>().error.code]).toEqual([
      422,
      'cabinet_too_big',
    ]);
    // Within them: described, and saved.
    const small = await fresh('owner', ['person', 'kind']);
    expect(small.size).toMatchObject({ cabinets: 1, over: null });
    expect(nodeLevels(small.layout.levels ?? [])).toEqual(['person', 'kind']);
  });

  it('puts the smallest of more than 100 dividers behind Everything else, which lists exactly them', async () => {
    // 102 years of Sam's statements: a year divider each, but 100 shown at most.
    for (let i = 0; i < 102; i += 1) {
      await file('adult', {
        title: `Sam old statement ${1900 + i}`,
        type_key: 'bank_statement',
        owner_member_id: member('adult'),
        visibility: 'household',
        issued: day(`${1900 + i}-06-01`),
      });
    }
    // Two of one year: the year kept; the smallest behind Everything else.
    await file('adult', {
      title: 'Sam old statement 1900 again',
      type_key: 'bank_statement',
      owner_member_id: member('adult'),
      visibility: 'household',
      issued: day('1900-07-01'),
    });
    await saved('adult', {
      levels: null,
      cabinets: [
        byHand('old', [
          {
            id: 'old-years',
            name: 'Old years',
            hidden: false,
            filter: {
              member_id: member('adult'),
              dated_from: '1900-01-01',
              dated_to: '2001-12-31',
              notes: 'exclude',
            },
            dividers: { levels: ['year'], ranges: [] },
          },
        ]),
      ],
    });
    const c = await opened('adult', 'old-years');
    expect(c.dividers).toHaveLength(100);
    const rest = c.dividers.at(-1);
    expect(rest).toMatchObject({ key: 'rest', name: 'Everything else' });
    expect(rest?.count).toBe(3);
    expect(c.dividers.find((d) => d.key === 'year:1900')?.count).toBe(2);
    expect(c.dividers.reduce((n, d) => n + d.count, 0)).toBe(c.total);
    const page = await ok<DocumentPage>(behind('adult', 'old-years', 'rest'));
    expect(page.total).toBe(3);
    const shown = new Set(c.dividers.map((d) => d.name));
    for (const d of page.items) {
      expect(shown.has(d.issued?.date.slice(0, 4) ?? '')).toBe(false);
    }
  });

  it('takes what an older app sends, and tells it arranged by hand', async () => {
    const hand = byHand('older', []);
    const at0 = await mine('owner');
    const sent = await ok<CabinetView>(
      save(
        'owner',
        { arranged_by: 'person_kind', cabinets: [hand] } as unknown as CabinetLayout,
        at0.version,
      ),
    );
    expect(sent.layout).toEqual({ levels: null, arranged_by: null, cabinets: [hand] });
    const read = await mine('owner');
    expect(read.layout?.arranged_by).toBeNull();
    expect(read.layout?.levels).toBeNull();
    // A folder's dividers: at most two levels, each once.
    const three = await save(
      'owner',
      {
        levels: null,
        cabinets: [
          byHand('x', [
            {
              id: 'x-f',
              name: 'X',
              hidden: false,
              filter: {},
              dividers: { levels: ['kind', 'year', 'topic'], ranges: [] },
            },
          ]),
        ],
      },
      read.version,
    );
    expect(three.statusCode).toBe(422);
    const twice = await save(
      'owner',
      {
        levels: null,
        cabinets: [
          byHand('x', [
            {
              id: 'x-f',
              name: 'X',
              hidden: false,
              filter: {},
              dividers: { levels: ['kind', 'kind'], ranges: [] },
            },
          ]),
        ],
      },
      read.version,
    );
    expect(twice.json<{ error: { code: string } }>().error.code).toBe('cabinet_divider_levels');
  });

  it('keeps arranging out of the household’s activity', async () => {
    const before = await ok<{ items: unknown[] }>(call('owner', 'GET', '/api/v1/audit?limit=100'));
    const p = await fresh('owner', ['kind', 'person']);
    await saved('owner', p.layout);
    const after = await ok<{ items: unknown[] }>(call('owner', 'GET', '/api/v1/audit?limit=100'));
    expect(JSON.stringify(after.items)).toBe(JSON.stringify(before.items));
  });
});
