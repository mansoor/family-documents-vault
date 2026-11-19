import { testAdminUrl } from '@fdv/db/testing';
import {
  type CabinetCounts,
  type CabinetLayout,
  type CabinetPreview,
  type CabinetView,
  type DocumentPage,
  type Tokens,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The whole cabinet (19 Nov 2026): the owner's Table said 15 documents and
 * the Cabinet, drawn by topic, then year, then person, had no Financial
 * cabinet. A drawn layout was a snapshot of the topics there were when it
 * was drawn: the bank statement and payslip added since — Sensitive, kept
 * to the adults — had no folder. Now a drawn cabinet is kept up to date as
 * it is read, and the cabinet says how many documents it holds, each once:
 * always the table's own total, for the same person.
 */

type Person = 'owner' | 'adult' | 'teen' | 'viewer';

describe.skipIf(!testAdminUrl())('the whole cabinet', () => {
  let h: Harness;
  const people = {} as Record<Person, Tokens>;
  const ids = {} as Record<string, string>;
  const year = new Date().getUTCFullYear();
  /** Each statement the API runs, while a test listens. */
  const statements: string[] = [];
  let listening = false;

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
      remoteAddress: `10.119.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as T;
  };
  const member = (who: Person) => people[who].member_id;
  const file = async (who: Person, body: object) =>
    (await ok<{ id: string }>(call(who, 'POST', '/api/v1/documents', body))).id;
  const day = (y: number, md: string) => ({ date: `${y}-${md}`, precision: 'day' });
  const mine = (who: Person) => ok<CabinetView>(call(who, 'GET', '/api/v1/cabinet'));
  const saved = async (who: Person, layout: CabinetLayout) => {
    const at = await mine(who);
    return ok<CabinetView>(call(who, 'PUT', '/api/v1/cabinet', { layout, version: at.version }));
  };
  const counts = (who: Person) => ok<CabinetCounts>(call(who, 'GET', '/api/v1/cabinet/counts'));
  /** The Documents table's total, unfiltered, as the web asks it. */
  const tableTotal = async (who: Person): Promise<number> => {
    const page = await ok<DocumentPage>(
      call(who, 'GET', '/api/v1/documents?sort=title&notes=exclude&limit=1'),
    );
    expect(typeof page.total).toBe('number');
    return page.total as number;
  };
  const unfiled = (who: Person) =>
    ok<DocumentPage>(call(who, 'GET', '/api/v1/cabinet/unfiled?limit=200'));
  const shownFolders = (l: CabinetLayout) =>
    l.cabinets
      .filter((c) => !c.hidden)
      .flatMap((c) =>
        c.drawers
          .filter((d) => !d.hidden)
          .flatMap((d) =>
            d.folders.filter((f) => !f.hidden).map((f) => ({ path: [c.name, d.name, f.name], f })),
          ),
      );

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 10_000,
      log: (e) => {
        if (listening) statements.push(e.query.sql);
      },
    });
    people.owner = await h.setup({ display_name: 'Maya Shah' });
    people.adult = await h.join(people.owner, {
      name: 'Ravi Shah',
      email: 'whole-ravi@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Esha Shah',
      email: 'whole-esha@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Nani Shah',
      email: 'whole-nani@example.test',
      role: 'viewer',
    });
    // The owner's household before the financial papers: as the preview vault had it.
    ids.passport = await file('owner', {
      title: 'Maya passport',
      type_key: 'passport',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(year - 9, '05-01'),
    });
    ids.visa = await file('owner', {
      title: 'Esha visa',
      type_key: 'visa',
      owner_member_id: member('teen'),
      visibility: 'household',
      issued: day(year - 5, '02-01'),
    });
    ids.bill = await file('owner', {
      title: 'Water bill',
      type_key: 'utility_bill',
      household_owned: true,
      visibility: 'household',
      issued: day(year, '01-15'),
    });
    ids.diploma = await file('owner', {
      title: 'Maya diploma',
      type_key: 'diploma',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(1998, '06-30'),
    });
    ids.car = await file('owner', {
      title: 'Car registration',
      type_key: 'vehicle_registration',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(year, '03-01'),
    });
    ids.taxPrivate = await file('owner', {
      title: 'Maya tax form',
      type_key: 'tax_form',
      owner_member_id: member('owner'),
      visibility: 'private',
      issued: day(year, '04-01'),
    });
    ids.otherAdults = await file('owner', {
      title: 'Maya letter',
      type_key: 'other',
      owner_member_id: member('owner'),
      visibility: 'adults',
      issued: day(year, '02-02'),
    });
    // No longer needed: still a document the table lists.
    ids.oldVisa = await file('owner', {
      title: 'Maya old visa',
      type_key: 'visa',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day(year - 12, '07-07'),
    });
    await ok(call('owner', 'POST', `/api/v1/documents/${ids.oldVisa}/no-longer-needed`, {}));
    // In the Trash, and a note: never counted by either.
    ids.trashed = await file('owner', {
      title: 'Trashed',
      type_key: 'passport',
      owner_member_id: member('owner'),
      visibility: 'household',
    });
    expect((await call('owner', 'DELETE', `/api/v1/documents/${ids.trashed}`)).statusCode).toBe(
      204,
    );
    await file('owner', {
      title: 'A note',
      type_key: 'note',
      notes: 'Boiler',
      visibility: 'household',
    });
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  it('holds papers of a topic added after it was drawn: the 19 Nov Financial cabinet', async () => {
    const drawn = await ok<CabinetPreview>(
      call('owner', 'POST', '/api/v1/cabinet/preview', { arrange_by: 'category_year_person' }),
    );
    expect(drawn.layout.cabinets.map((c) => c.name)).not.toContain('Financial');
    const first = await saved('owner', drawn.layout);
    // Then the bank statement and payslip: Sensitive by their kind, kept to the adults.
    ids.bank = await file('owner', {
      title: 'Maya bank statement',
      type_key: 'bank_statement',
      owner_member_id: member('owner'),
      visibility: 'adults',
      issued: day(year, '10-31'),
    });
    ids.pay = await file('owner', {
      title: 'Maya payslip',
      type_key: 'pay_statement',
      owner_member_id: member('owner'),
      visibility: 'adults',
      issued: day(year, '11-01'),
    });
    const doc = await ok<{ sensitive_effective: boolean }>(
      call('owner', 'GET', `/api/v1/documents/${ids.bank}`),
    );
    expect(doc.sensitive_effective).toBe(true);

    const now = await mine('owner');
    expect(now.version).toBe(first.version + 1);
    const layout = now.layout as CabinetLayout;
    const names = layout.cabinets.map((c) => c.name);
    // In the drawing's order of topics, the rest as they were.
    expect(names).toContain('Financial');
    expect(names.indexOf('Financial')).toBeLessThan(names.indexOf('Tax'));
    for (const was of first.layout?.cabinets ?? []) expect(layout.cabinets).toContainEqual(was);
    const got = await counts('owner');
    const financial = shownFolders(layout).filter((x) => x.path[0] === 'Financial');
    expect(financial.map((x) => x.path)).toEqual([['Financial', String(year), 'Maya']]);
    expect(got.counts[financial[0]?.f.id as string]).toBe(2);
    // Held whole, and said so: the table's total, nothing left out.
    expect(got.documents).toBe(await tableTotal('owner'));
    expect(got.documents).toBe(10);
    expect(got.unfiled).toBe(0);
    expect(got.in_several).toBe(0);
    // Read again: nothing more to add, and the papers not looked over again.
    statements.length = 0;
    listening = true;
    expect((await mine('owner')).version).toBe(now.version);
    listening = false;
    expect(statements.filter((q) => q.includes('documentPlaces'))).toEqual([]);
  });

  it('a cabinet arranged by hand is never changed: what it holds nowhere is counted, and listed', async () => {
    await saved('adult', {
      arranged_by: null,
      cabinets: [
        {
          id: 'c',
          name: 'Papers',
          hidden: false,
          drawers: [
            {
              id: 'd',
              name: 'Drawer',
              hidden: false,
              folders: [
                { id: 'id', name: 'Identity', hidden: false, filter: { category: 'identity' } },
              ],
            },
          ],
        },
      ],
    });
    const before = await mine('adult');
    expect((await mine('adult')).version).toBe(before.version);
    const got = await counts('adult');
    const total = await tableTotal('adult');
    expect(got.documents).toBe(total);
    const list = await unfiled('adult');
    expect(list.total).toBe(got.unfiled);
    expect(got.unfiled).toBe(total - (got.counts.id ?? 0));
    expect(list.items.map((d) => d.id)).not.toContain(ids.passport);
    expect(list.items.map((d) => d.id)).toContain(ids.bill);
    // Never the owner's Only me.
    expect(list.items.map((d) => d.id)).not.toContain(ids.taxPrivate);
  });

  it('counts each paper once however many folders hold it, and says so', async () => {
    const twoFolders: CabinetLayout = {
      arranged_by: null,
      cabinets: [
        {
          id: 'c',
          name: 'Papers',
          hidden: false,
          drawers: [
            {
              id: 'd',
              name: 'Drawer',
              hidden: false,
              folders: [
                { id: 'ids', name: 'Identity', hidden: false, filter: { category: 'identity' } },
                { id: 'all', name: 'Everything', hidden: false, filter: { notes: 'exclude' } },
                { id: 'house', name: 'House', hidden: false, filter: { category: 'bills' } },
              ],
            },
          ],
        },
      ],
    };
    await saved('owner', twoFolders);
    // The passport pinned into House too: in three folders now.
    await ok(
      call('owner', 'POST', '/api/v1/cabinet/folders/house/pins', { document_ids: [ids.passport] }),
    );
    const got = await counts('owner');
    const total = await tableTotal('owner');
    expect(got.documents).toBe(total);
    const sum = Object.values(got.counts).reduce<number>((n, x) => n + (x ?? 0), 0);
    expect(sum).toBeGreaterThan(total);
    // Identity's three and the bill are each in two or more; the rest in Everything alone.
    expect(got.in_several).toBe(4);
    expect(got.unfiled).toBe(0);
    expect((await unfiled('owner')).items).toEqual([]);
  });

  it('holds exactly what the table lists, for each person, whatever its mix', async () => {
    // A paper with no kind: in no folder of a drawing, and said so.
    ids.scan = await file('owner', { title: 'A scan to sort', visibility: 'household' });
    for (const who of ['owner', 'adult', 'teen', 'viewer'] as Person[]) {
      const drawn = await ok<CabinetPreview>(
        call(who, 'POST', '/api/v1/cabinet/preview', { arrange_by: 'person_category_year' }),
      );
      await saved(who, drawn.layout);
      const got = await counts(who);
      const total = await tableTotal(who);
      expect(got.documents, who).toBe(total);
      expect(got.documents, who).toBe(drawn.documents);
      expect(got.unfiled, who).toBe(drawn.left_out);
      const list = await unfiled(who);
      expect(
        list.items.map((d) => d.id),
        who,
      ).toEqual([ids.scan]);
    }
    // Who sees what: the owner all ten and the scan; the adult not her Only me;
    // the teen and the viewer nothing kept to the adults either.
    expect((await counts('owner')).documents).toBe(11);
    expect((await counts('adult')).documents).toBe(10);
    expect((await counts('teen')).documents).toBe(7);
    expect((await counts('viewer')).documents).toBe(7);
  });

  it('never names a part with " › ", and saves what it drew as PUT would take it', async () => {
    // Two Anns: each is named in full, " › " and all.
    const ann = await ok<{ id: string }>(
      call('owner', 'POST', '/api/v1/members', { display_name: 'Ann › Lee' }),
    );
    await ok(call('owner', 'POST', '/api/v1/members', { display_name: 'Ann Ray' }));
    await file('owner', {
      title: 'Ann tax form',
      type_key: 'tax_form',
      owner_member_id: ann.id,
      visibility: 'household',
      issued: day(year, '05-05'),
    });
    const now = await mine('owner');
    const names = (now.layout as CabinetLayout).cabinets.map((c) => c.name);
    expect(names.some((n) => n.startsWith('Ann - Lee'))).toBe(true);
    expect(names.join('\n')).not.toContain(' › ');
    // As drawn, it saves.
    const again = await call('owner', 'PUT', '/api/v1/cabinet', {
      layout: now.layout,
      version: now.version,
    });
    expect(again.statusCode, again.body).toBe(200);
  });

  it('looks the papers over only when one has changed since', async () => {
    const before = await mine('owner');
    // Nothing changed since: not looked over at all.
    statements.length = 0;
    listening = true;
    await mine('owner');
    listening = false;
    expect(statements.filter((q) => q.includes('documentPlaces'))).toEqual([]);
    // A paper with no kind added: looked over once, nothing to add…
    await file('owner', { title: 'Another scan', visibility: 'household' });
    listening = true;
    const looked = await mine('owner');
    listening = false;
    expect(statements.filter((q) => q.includes('documentPlaces')).length).toBeGreaterThan(0);
    expect(looked.version).toBe(before.version);
    // …and not again while nothing changes.
    statements.length = 0;
    listening = true;
    await mine('owner');
    listening = false;
    expect(statements.filter((q) => q.includes('documentPlaces'))).toEqual([]);
    // In no folder, and said so.
    expect((await counts('owner')).unfiled).toBe(2);
  });
});
