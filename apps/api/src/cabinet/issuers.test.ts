import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  issuerKey,
  storedIssuerKey,
  type CabinetCounts,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetLevel,
  type CabinetPreview,
  type CabinetView,
  type DocumentPage,
  type FolderContents,
  type IssuerGroups,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Who issued it as a cabinet level (0.9.0-dev.91), through the API as each
 * member of a household: the issuer key kept with `issued_by` on every way
 * a paper is written; the household's "Same as" list, one level only, kept
 * by owners and adults, suggested and never merged silently, and followed by
 * the cabinet, its dividers, growing and the Who issued it filter alike;
 * "No issuer given"; and every name, count and suggestion from the side of
 * whoever must not see: somebody else's Only me, and a paper kept to the
 * adults from a teen.
 */

type Person = 'owner' | 'adult' | 'teen' | 'other';

const SECRETS = {
  /** Olive's own letter from a lender, Only me: its issuer is hers to know. */
  onlyMe: 'Quietly Lending Ltd',
  /** A letter about Tia kept to the adults: its issuer is theirs. */
  adults: 'Northfield Clinic',
};

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

describe.skipIf(!testAdminUrl())('who issued it, as a cabinet level', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const people = {} as Record<Person, Tokens>;
  const ids = {} as Record<string, string>;
  let nth = 0;
  let listening = false;
  const statements: string[] = [];
  const year = new Date().getUTCFullYear();

  const call = (
    who: Person,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
  const mine = (who: Person) => ok<CabinetView>(call(who, 'GET', '/api/v1/cabinet'));
  const saved = async (who: Person, layout: CabinetLayout) => {
    const at = await mine(who);
    return ok<CabinetView>(call(who, 'PUT', '/api/v1/cabinet', { layout, version: at.version }));
  };
  const fresh = (who: Person, levels: CabinetLevel[]) =>
    ok<CabinetPreview>(
      call(who, 'POST', '/api/v1/cabinet/preview', {
        levels,
        layout: { levels: null, cabinets: [] },
      }),
    );
  const groups = (who: Person) => ok<IssuerGroups>(call(who, 'GET', '/api/v1/issuers/groups'));
  const same = (who: Person, from: string, to: string) =>
    call(who, 'POST', '/api/v1/issuers/same', { from, to });
  const separate = (who: Person, from: string, to: string) =>
    call(who, 'POST', '/api/v1/issuers/separate', { from, to });
  const tableTotal = async (who: Person, filter: Record<string, string>) => {
    const q = new URLSearchParams({ sort: 'title', limit: '1', ...filter });
    return (await ok<DocumentPage>(call(who, 'GET', `/api/v1/documents?${q.toString()}`))).total;
  };
  const listed = async (who: Person, filter: Record<string, string>) => {
    const q = new URLSearchParams({ limit: '200', ...filter });
    return (
      await ok<DocumentPage>(call(who, 'GET', `/api/v1/documents?${q.toString()}`))
    ).items.map((d) => d.title);
  };
  const activity = async (who: Person) =>
    (
      await ok<{ items: Array<{ text: string }> }>(call(who, 'GET', '/api/v1/audit?limit=100'))
    ).items.map((l) => l.text);
  const keyOf = async (id: string) =>
    (
      await admin.query<{ issuer_key: string | null }>(
        'select issuer_key from document where id = $1',
        [id],
      )
    ).rows[0]?.issuer_key;
  const folders = (l: CabinetLayout) =>
    l.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders.map((f) => ({ c, d, f }))));
  const paper = async (who: Person, title: string, issued_by: string | null, more: object = {}) =>
    (
      await ok<{ id: string }>(
        call(who, 'POST', '/api/v1/documents', {
          title,
          type_key: 'bank_statement',
          owner_member_id: member(who === 'teen' ? 'teen' : who),
          visibility: 'household',
          issued: { date: `${year}-03-01`, precision: 'day' },
          ...(issued_by === null ? {} : { issued_by }),
          ...more,
        }),
      )
    ).id;

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      // Each statement the API runs, while a test listens.
      log: (e) => {
        if (listening) statements.push(e.query.sql);
      },
    });
    admin = createPool(h.adminUrl, 2);
    people.owner = await h.setup({ display_name: 'Olive Khan' });
    people.adult = await h.join(people.owner, {
      name: 'Sam Khan',
      email: 'issuers-sam@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia Khan',
      email: 'issuers-tia@example.test',
      role: 'teen',
    });
    people.other = await h.join(people.owner, {
      name: 'Rafi Khan',
      email: 'issuers-rafi@example.test',
      role: 'adult',
    });
    ids.barclays1 = await paper('owner', 'Barclays March', 'Barclays');
    ids.barclays2 = await paper('owner', 'Barclays April', 'Barclays');
    ids.barclays3 = await paper('adult', 'Sam Barclays', 'barclays');
    ids.barclaysUk = await paper('owner', 'Barclays UK letter', 'BARCLAYS BANK UK PLC');
    ids.barclaysUk2 = await paper('adult', 'Sam Barclays UK', 'Barclays Bank UK');
    ids.hsbc = await paper('owner', 'HSBC letter', 'HSBC');
    ids.hsbcUk = await paper('owner', 'HSBC UK letter', 'HSBC UK');
    ids.none = await paper('owner', 'A statement from nobody said', null);
    ids.onlyMe = await paper('owner', 'Olive lender', SECRETS.onlyMe, { visibility: 'private' });
    ids.adults = await paper('owner', 'Tia clinic letter', SECRETS.adults, {
      owner_member_id: member('teen'),
      visibility: 'adults',
      type_key: 'medical_record',
    });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h.close();
  });

  it('says it can', async () => {
    const caps = await ok<{ features: { cabinet_issuer?: boolean } }>(
      call('owner', 'GET', '/api/v1/capabilities'),
    );
    expect(caps.features.cabinet_issuer).toBe(true);
  });

  it('keeps the issuer key with who issued it, as it is made, changed, captured and cleared', async () => {
    expect(await keyOf(ids.barclaysUk as string)).toBe('barclays bank uk');
    expect(await keyOf(ids.barclaysUk2 as string)).toBe('barclays bank uk');
    expect(await keyOf(ids.none as string)).toBeNull();
    const id = await paper('owner', 'Changing', 'The Co-operative Bank p.l.c.');
    expect(await keyOf(id)).toBe(issuerKey('Co-operative Bank'));
    await ok(call('owner', 'PATCH', `/api/v1/documents/${id}`, { issued_by: 'Société Générale' }));
    expect(await keyOf(id)).toBe('societe generale');
    // Something else changed: the key stays.
    await ok(call('owner', 'PATCH', `/api/v1/documents/${id}`, { title: 'Changed again' }));
    expect(await keyOf(id)).toBe('societe generale');
    // Nothing left to compare: the text itself, never "no issuer"; nothing at all: no key.
    await ok(call('owner', 'PATCH', `/api/v1/documents/${id}`, { issued_by: 'Ltd.' }));
    expect(await keyOf(id)).toBe('ltd.');
    await ok(call('owner', 'PATCH', `/api/v1/documents/${id}`, { issued_by: null }));
    expect(await keyOf(id)).toBeNull();
    // A capture (the phone, a batch's filing) writes it too.
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({ type_key: 'utility_bill', issued_by: 'British Gas Ltd' }),
    );
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const captured = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: { ...h.as(people.owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(captured.statusCode, captured.body).toBe(201);
    expect(await keyOf(captured.json<{ document_id: string }>().document_id)).toBe('british gas');
    for (const gone of [id, captured.json<{ document_id: string }>().document_id]) {
      expect((await call('owner', 'DELETE', `/api/v1/documents/${gone}`)).statusCode).toBeLessThan(
        300,
      );
    }
  });

  it('keeps exactly the shared key, whatever is written: case, accents, punctuation, legal forms, a leading The, other scripts', async () => {
    const id = await paper('owner', 'Every spelling', null);
    for (const written of [
      'Barclays Bank UK PLC',
      '  barclays   bank uk plc. ',
      'The Co-operative Bank',
      'Foo & Co. Ltd',
      'Société Générale S.A.',
      'Zürich Insurance Group',
      'İstanbul Bankası',
      'Müller-Lüdenscheidt GmbH',
      'ﬁnance house',
      'O’Brien & Sons LLC',
      '東京電力',
      'بنك مسقط',
      'Ltd',
      '---',
      '   ',
    ]) {
      await ok(call('owner', 'PATCH', `/api/v1/documents/${id}`, { issued_by: written }));
      expect(await keyOf(id), written).toBe(storedIssuerKey(written));
    }
    expect((await call('owner', 'DELETE', `/api/v1/documents/${id}`)).statusCode).toBeLessThan(300);
  });

  it('groups each reader’s issuers by key, named and counted only from what they can read', async () => {
    const olive = await groups('owner');
    const barclaysUk = olive.items.find((g) => g.key === 'barclays bank uk');
    // Two spellings, one key; the most used spelling named.
    expect(barclaysUk?.count).toBe(2);
    expect(olive.items.find((g) => g.key === 'barclays')).toMatchObject({
      name: 'Barclays',
      count: 3,
      members: [],
    });
    expect(olive.items.map((g) => g.name)).toContain(SECRETS.onlyMe);
    expect(olive.may_change).toBe(true);
    const sam = await groups('adult');
    expect(sam.items.map((g) => g.name)).not.toContain(SECRETS.onlyMe);
    expect(sam.items.map((g) => g.name)).toContain(SECRETS.adults);
    const tia = await groups('teen');
    expect(JSON.stringify(tia)).not.toContain(SECRETS.onlyMe);
    expect(JSON.stringify(tia)).not.toContain(SECRETS.adults);
    expect(tia.may_change).toBe(false);
    expect(tia.same_as).toEqual([]);
  });

  it('suggests what looks like one by its leading words, and never merges it by itself', async () => {
    const olive = await groups('owner');
    expect(olive.same_as).toContainEqual({
      from: { key: 'barclays bank uk', name: expect.any(String) as string, count: 2 },
      to: { key: 'barclays', name: 'Barclays', count: 3 },
    });
    expect(olive.same_as.some((s) => s.from.key === 'hsbc uk' && s.to.key === 'hsbc')).toBe(true);
    // Nothing joined: the Who issued it filter finds Barclays alone.
    expect(await listed('owner', { issued_by: 'Barclays' })).not.toContain('Barclays UK letter');
  });

  it('lets owners and adults alone say two are the same, and only of what they can read', async () => {
    expect((await same('teen', 'barclays bank uk', 'barclays')).statusCode).toBe(403);
    // Olive's Only me lender is not Sam's to name.
    const hidden = issuerKey(SECRETS.onlyMe);
    expect((await same('adult', hidden, 'barclays')).statusCode).toBe(404);
    expect((await same('adult', 'barclays', 'barclays')).statusCode).toBe(422);
    expect((await same('adult', 'Barclays', 'barclays')).statusCode).toBe(422);
  });

  it('joins one issuer to another, followed by the filter, and said in the household’s activity', async () => {
    const joined = await ok<IssuerGroups>(same('owner', 'barclays bank uk', 'barclays'));
    const g = joined.items.find((x) => x.key === 'barclays');
    expect(g).toMatchObject({ name: 'Barclays', count: 5 });
    expect(g?.members.map((m) => m.key)).toEqual(['barclays bank uk']);
    expect(joined.same_as.some((s) => s.from.key === 'barclays bank uk')).toBe(false);
    // The Who issued it filter, by either spelling, finds both.
    const both = ['Barclays March', 'Barclays April', 'Sam Barclays', 'Barclays UK letter'];
    for (const asked of ['Barclays', 'barclays bank uk plc']) {
      const titles = await listed('owner', { issued_by: asked });
      for (const t of both) expect(titles, asked).toContain(t);
    }
    expect(await tableTotal('owner', { issuer: 'barclays' })).toBe(5);
    expect(await tableTotal('owner', { issuer: 'barclays bank uk' })).toBe(5);
    // No paper was changed.
    const doc = await ok<{ issued_by: string }>(
      call('owner', 'GET', `/api/v1/documents/${ids.barclaysUk}`),
    );
    expect(doc.issued_by).toBe('BARCLAYS BANK UK PLC');
    const line = (t: string) =>
      /said “.*Barclays Bank UK.*” is the same issuer as “Barclays”/i.test(t);
    expect((await activity('owner')).some(line)).toBe(true);
    expect((await activity('adult')).some(line)).toBe(true);
    const teen = await call('teen', 'GET', '/api/v1/audit?limit=100');
    if (teen.statusCode === 200) {
      expect(teen.json<{ items: Array<{ text: string }> }>().items.some((l) => line(l.text))).toBe(
        false,
      );
    }
  });

  it('counts each of the household’s issuers by its key and the list, as its chip’s filter lists it', async () => {
    const chips = await ok<{ items: Array<{ issued_by: string; count: number }> }>(
      call('owner', 'GET', '/api/v1/issuers'),
    );
    const barclays = chips.items.filter((i) => /barclays/i.test(i.issued_by));
    expect(barclays).toHaveLength(1);
    for (const chip of chips.items) {
      expect(chip.count, chip.issued_by).toBe(
        await tableTotal('owner', { issued_by: chip.issued_by }),
      );
    }
  });

  it('keeps the list one level deep: a group joined to another moves whole, and comes back whole', async () => {
    const list = async () =>
      (
        await admin.query<{ from_key: string; to_key: string; path: string[] }>(
          'select from_key, to_key, path from issuer_alias order by from_key',
        )
      ).rows;
    await ok(same('adult', 'hsbc uk', 'hsbc'));
    await ok(same('adult', 'hsbc', 'barclays'));
    expect(await list()).toEqual([
      { from_key: 'barclays bank uk', to_key: 'barclays', path: [] },
      { from_key: 'hsbc', to_key: 'barclays', path: [] },
      { from_key: 'hsbc uk', to_key: 'barclays', path: ['hsbc'] },
    ]);
    // Said again: nothing changes.
    await ok(same('adult', 'hsbc uk', 'barclays bank uk'));
    // HSBC separated: HSBC UK, which it brought, comes back with it.
    await ok(separate('adult', 'hsbc', 'barclays'));
    expect(await list()).toEqual([
      { from_key: 'barclays bank uk', to_key: 'barclays', path: [] },
      { from_key: 'hsbc uk', to_key: 'hsbc', path: [] },
    ]);
    expect((await activity('owner')).some((t) => /separated “HSBC” from “Barclays”/.test(t))).toBe(
      true,
    );
    await ok(separate('adult', 'hsbc uk', 'hsbc'));
    expect((await list()).map((r) => r.from_key)).toEqual(['barclays bank uk']);
    expect((await activity('owner')).some((t) => /separated “HSBC UK” from “HSBC”/.test(t))).toBe(
      true,
    );
    // Said separate: never suggested as one again.
    const like = (g: IssuerGroups) =>
      g.same_as.some((s) => s.from.key === 'hsbc uk' && s.to.key === 'hsbc');
    expect(like(await groups('adult'))).toBe(false);
    // Never joined, kept apart: no line for it.
    const lines = (await activity('owner')).length;
    await ok(separate('adult', 'hsbc', 'barclays bank uk'));
    expect((await activity('owner')).length).toBe(lines);
  });

  it('draws a cabinet by who issued it, the household’s names and "No issuer given" among them', async () => {
    for (const who of ['owner', 'adult', 'teen'] as Person[]) {
      const p = await fresh(who, ['issuer', 'person']);
      const cabinet = p.layout.cabinets[0];
      const drawers = cabinet?.drawers.map((d) => d.name) ?? [];
      expect(drawers).toContain('Barclays');
      expect(drawers).not.toContain('BARCLAYS BANK UK PLC');
      expect(drawers[drawers.length - 1]).toBe('No issuer given');
      expect(JSON.stringify(p.layout).includes(SECRETS.onlyMe)).toBe(who === 'owner');
      expect(JSON.stringify(p.layout).includes(SECRETS.adults)).toBe(who !== 'teen');
      // Each folder holds what the table gives its question.
      for (const { f } of folders(p.layout)) {
        expect(p.counts[f.id], `${who} ${f.name}`).toBe(
          await tableTotal(who, f.filter as Record<string, string>),
        );
      }
      // Suggestions only for those who may say Same.
      expect(p.same_as === undefined || Array.isArray(p.same_as)).toBe(true);
      if (who === 'teen') expect(p.same_as).toEqual([]);
    }
  });

  it('divides a folder by who issued it, named as the household names it, none given last', async () => {
    const types = await ok<{ items: Array<{ key: string; category: string | null }> }>(
      call('owner', 'GET', '/api/v1/document-types?all=true'),
    );
    const financial = types.items.find((t) => t.key === 'bank_statement')?.category;
    const p = await fresh('owner', ['person', 'topic', 'year', 'issuer']);
    await saved('owner', p.layout);
    const folder = folders(p.layout).find(
      (x) =>
        x.f.filter.member_id === member('owner') &&
        x.f.filter.dated_from === `${year}-01-01` &&
        x.f.filter.category === financial,
    )?.f as CabinetFolder;
    expect(folder.dividers).toEqual({ levels: ['issuer'], ranges: [] });
    const c = await ok<FolderContents>(
      call('owner', 'GET', `/api/v1/cabinet/folders/${folder.id}`),
    );
    const names = c.dividers.map((d) => d.name);
    expect(names).toContain('Barclays');
    expect(names[names.length - 1]).toBe('No issuer given');
    const barclays = c.dividers.find((d) => d.key === 'issuer:barclays');
    expect(barclays?.path).toEqual([{ level: 'issuer', key: 'issuer:barclays', name: 'Barclays' }]);
    // Barclays: Olive's two, and the Barclays Bank UK letter joined to it.
    expect(barclays?.count).toBe(3);
    const behind = await ok<DocumentPage>(
      call(
        'owner',
        'GET',
        `/api/v1/cabinet/folders/${folder.id}/documents?divider=${encodeURIComponent('issuer:barclays')}`,
      ),
    );
    expect(behind.items.map((d) => d.title).sort()).toEqual(
      ['Barclays April', 'Barclays March', 'Barclays UK letter'].sort(),
    );
    const none = await ok<DocumentPage>(
      call('owner', 'GET', `/api/v1/cabinet/folders/${folder.id}/documents?divider=issuer:`),
    );
    expect(none.items.map((d) => d.title)).toContain('A statement from nobody said');
    expect(c.dividers.reduce((n, d) => n + d.count, 0)).toBe(c.total);
  });

  it('grows a drawn cabinet when two issuers are separated, and a paper with none lands in No issuer given', async () => {
    const p = await fresh('adult', ['issuer', 'person']);
    await saved('adult', p.layout);
    const before = folders((await mine('adult')).layout as CabinetLayout);
    expect(before.some((x) => x.f.filter.issuer === 'barclays bank uk')).toBe(false);
    await ok(separate('adult', 'barclays bank uk', 'barclays'));
    const after = folders((await mine('adult')).layout as CabinetLayout);
    expect(after.some((x) => x.f.filter.issuer === 'barclays bank uk')).toBe(true);
    await paper('adult', 'Sam statement, nobody said', null);
    const grown = folders((await mine('adult')).layout as CabinetLayout);
    const none = grown.filter((x) => x.f.filter.issuer === '_none');
    for (const x of none) expect(x.d.name).toBe('No issuer given');
    expect(none.some((x) => x.f.filter.member_id === member('adult'))).toBe(true);
  });

  it('makes one folder, or one cabinet, of issuers said to be the same, pins and counts kept, and grows them apart again when separated', async () => {
    const one = await paper('owner', 'Wren one', 'Wren Bank');
    await paper('owner', 'Wren two', 'Wren Bank');
    await paper('owner', 'Wren savings', 'Wren Bank Savings');
    const wren = (f: CabinetFolder) =>
      (f.filter.issuer ?? '').split(',').some((k) => k.startsWith('wren bank'));
    // Olive: Who issued it makes the folders. Sam: it makes the cabinets.
    await saved('owner', (await fresh('owner', ['topic', 'person', 'issuer'])).layout);
    await saved('adult', (await fresh('adult', ['issuer', 'year', 'person'])).layout);
    const hers = () =>
      mine('owner').then((v) => folders(v.layout as CabinetLayout).filter((x) => wren(x.f)));
    const hisCabinets = () =>
      mine('adult').then((v) =>
        (v.layout as CabinetLayout).cabinets.filter((c) =>
          (c.drawn?.value ?? '').startsWith('wren bank'),
        ),
      );
    expect((await hers()).map((x) => x.f.filter.issuer).sort()).toEqual([
      'wren bank',
      'wren bank savings',
    ]);
    expect((await hisCabinets()).map((c) => c.drawn?.value).sort()).toEqual([
      'wren bank',
      'wren bank savings',
    ]);
    // A paper pinned into the savings folder by hand: it goes with the folder.
    const pinnedIn = (await hers()).find((x) => x.f.filter.issuer === 'wren bank savings')?.f
      .id as string;
    await ok(
      call('owner', 'POST', `/api/v1/cabinet/folders/${pinnedIn}/pins`, {
        document_ids: [one],
      }),
    );

    await ok(same('owner', 'wren bank savings', 'wren bank'));
    // One folder: Wren Bank's, the pin with it, holding exactly what the table gives.
    const merged = await hers();
    expect(merged.map((x) => x.f.filter.issuer)).toEqual(['wren bank']);
    const counted = await ok<CabinetCounts>(call('owner', 'GET', '/api/v1/cabinet/counts'));
    const survivor = merged[0]?.f as CabinetFolder;
    expect(counted.counts[survivor.id]).toBe(3);
    expect(counted.counts[survivor.id]).toBe(
      await tableTotal('owner', survivor.filter as Record<string, string>),
    );
    expect(counted.pins?.[survivor.id]).toBe(1);
    expect(counted.pins?.[pinnedIn]).toBeUndefined();
    // One cabinet for Sam.
    const cabs = await hisCabinets();
    expect(cabs.map((c) => c.drawn?.value)).toEqual(['wren bank']);
    const his = await ok<CabinetCounts>(call('adult', 'GET', '/api/v1/cabinet/counts'));
    const inIt = (cabs[0]?.drawers ?? []).flatMap((d) => d.folders);
    expect(inIt.reduce((n, f) => n + (his.counts[f.id] ?? 0), 0)).toBe(3);
    for (const f of inIt) {
      expect(his.counts[f.id]).toBe(await tableTotal('adult', f.filter as Record<string, string>));
    }

    await ok(separate('owner', 'wren bank savings', 'wren bank'));
    // Apart again: a folder and a cabinet grown for the savings, each holding its own.
    const two = await hers();
    expect(two.map((x) => x.f.filter.issuer).sort()).toEqual(['wren bank', 'wren bank savings']);
    const again = await ok<CabinetCounts>(call('owner', 'GET', '/api/v1/cabinet/counts'));
    for (const { f } of two) {
      expect(again.counts[f.id]).toBe(
        await tableTotal('owner', f.filter as Record<string, string>),
      );
    }
    expect((await hisCabinets()).map((c) => c.drawn?.value).sort()).toEqual([
      'wren bank',
      'wren bank savings',
    ]);
  });

  it('never tells a teen a key of an issuer they can read no paper of, nor answers a guess', async () => {
    await paper('owner', 'Clinic leaflet', 'Northfield Clinic Surgery');
    // The teen's surgery said to be the same as the adults' clinic: its own key
    // is one Tia can read no paper of.
    await ok(same('owner', 'northfield clinic surgery', issuerKey(SECRETS.adults)));
    const tia = await groups('teen');
    expect(JSON.stringify(tia)).not.toContain('"northfield clinic"');
    expect(tia.items.find((g) => g.key === 'northfield clinic surgery')?.count).toBe(1);
    // A guess is answered as a key nobody has: nothing, either way.
    expect(await tableTotal('teen', { issuer: 'northfield clinic' })).toBe(0);
    expect(await tableTotal('teen', { issuer: 'never heard of this' })).toBe(0);
    expect(await tableTotal('teen', { issued_by: 'Northfield Clinic' })).toBe(0);
    expect(await tableTotal('teen', { issuer: 'northfield clinic surgery' })).toBe(1);
    // The adults, who read both, find both by either.
    expect(await tableTotal('adult', { issuer: 'northfield clinic surgery' })).toBe(2);
    expect(await tableTotal('adult', { issuer: 'northfield clinic' })).toBe(2);
    // Nor in a drawing, or a folder's dividers.
    const p = await fresh('teen', ['person', 'topic', 'year', 'issuer']);
    expect(JSON.stringify(p.layout)).not.toContain('"northfield clinic"');
    await saved('teen', p.layout);
    const keys: string[] = [];
    for (const { f } of folders(p.layout)) {
      const c = await ok<FolderContents>(call('teen', 'GET', `/api/v1/cabinet/folders/${f.id}`));
      keys.push(...c.dividers.map((d) => d.key));
    }
    expect(keys).not.toContain('issuer:northfield clinic');
    const byIssuer = await fresh('teen', ['issuer', 'person']);
    const asked = folders(byIssuer.layout).map((x) => x.f.filter.issuer);
    expect(asked).toContain('northfield clinic surgery');
    expect(asked).not.toContain('northfield clinic');
  });

  it('names a join’s issuers to each reader by their own papers, and never one they can read none of', async () => {
    // Olive's Only me lender, said to be HSBC: Rafi reads no paper of the lender.
    await ok(same('owner', issuerKey(SECRETS.onlyMe), 'hsbc'));
    const hers = await activity('owner');
    expect(hers.some((t) => t.includes(`“${SECRETS.onlyMe}” is the same issuer as “HSBC”`))).toBe(
      true,
    );
    const rafi = await activity('other');
    expect(
      rafi.some((t) => t.includes('said an issuer you can’t see is the same issuer as “HSBC”')),
    ).toBe(true);
    expect(rafi.join('\n')).not.toContain('Quietly');
    // Sam's Only me clinic, read by Olive as his caregiver: Rafi reads none of it.
    expect(
      (
        await call('adult', 'POST', `/api/v1/members/${member('adult')}/caregivers`, {
          caregiver_member_id: member('owner'),
        })
      ).statusCode,
    ).toBe(201);
    await paper('adult', 'Sam prescription', 'Riverside Clinic', {
      type_key: 'prescription',
      visibility: 'private',
    });
    await ok(same('owner', 'riverside clinic', 'hsbc'));
    const rafiAfter = await activity('other');
    expect(rafiAfter.join('\n')).not.toContain('Riverside');
    expect(
      rafiAfter.filter((t) =>
        t.includes('said an issuer you can’t see is the same issuer as “HSBC”'),
      ),
    ).toHaveLength(2);
    expect(
      (await activity('adult')).some((t) =>
        t.includes('“Riverside Clinic” is the same issuer as “HSBC”'),
      ),
    ).toBe(true);
  });

  it('can never make a chain, however two changes meet', async () => {
    await paper('owner', 'Alder', 'Alder Trust');
    await paper('owner', 'Birch', 'Birch Trust');
    await paper('owner', 'Cedar', 'Cedar Trust');
    const oneLevel = async () => {
      const rows = (
        await admin.query<{ from_key: string; to_key: string }>(
          'select from_key, to_key from issuer_alias',
        )
      ).rows;
      const froms = new Set(rows.map((r) => r.from_key));
      expect(rows.filter((r) => froms.has(r.to_key))).toEqual([]);
    };
    await Promise.all([
      same('owner', 'alder trust', 'birch trust'),
      same('adult', 'birch trust', 'cedar trust'),
    ]);
    await oneLevel();
    await Promise.all([
      separate('owner', 'alder trust', 'birch trust'),
      same('adult', 'alder trust', 'cedar trust'),
      same('owner', 'cedar trust', 'alder trust'),
    ]);
    await oneLevel();
    // And the database refuses a chain whoever writes it.
    const { rows } = await admin.query<{ from_key: string; to_key: string }>(
      'select from_key, to_key from issuer_alias limit 1',
    );
    const row = rows[0] as { from_key: string; to_key: string };
    await expect(
      admin.query('insert into issuer_alias (household_id, from_key, to_key) values ($1, $2, $3)', [
        people.owner.household_id,
        'chained trust',
        row.from_key,
      ]),
    ).rejects.toThrow(/same as one that is the same as no other/);
  });

  it('treats a paper kept with an issuer but no key as no issuer given, everywhere alike, and still finds it as written', async () => {
    const id = await paper('owner', 'Legacy statement', 'Legacy Bank');
    await admin.query('update document set issuer_key = null where id = $1', [id]);
    expect(await listed('owner', { issued_by: 'Legacy Bank' })).toContain('Legacy statement');
    expect(await listed('owner', { issuer: '_none' })).toContain('Legacy statement');
    const p = await fresh('owner', ['issuer', 'person']);
    const none = folders(p.layout).filter((x) => x.f.filter.issuer === '_none');
    for (const { f } of none) {
      expect(p.counts[f.id]).toBe(await tableTotal('owner', f.filter as Record<string, string>));
    }
    expect(none.length).toBeGreaterThan(0);
  });

  it('brings back what a key brought, however deep the joins since: from the middle and from the top', async () => {
    for (const [title, by] of [
      ['Aspen', 'Aspen Fund'],
      ['Beech', 'Beech Fund'],
      ['Cypress', 'Cypress Fund'],
      ['Dogwood', 'Dogwood Fund'],
    ] as const) {
      await paper('owner', title, by);
    }
    const fund = async () =>
      (
        await admin.query<{ from_key: string; to_key: string; path: string[] }>(
          "select from_key, to_key, path from issuer_alias where from_key like '% fund' order by 1",
        )
      ).rows;
    const chain = async () => {
      await ok(same('owner', 'aspen fund', 'beech fund'));
      await ok(same('owner', 'beech fund', 'cypress fund'));
      await ok(same('owner', 'cypress fund', 'dogwood fund'));
      expect(await fund()).toEqual([
        { from_key: 'aspen fund', to_key: 'dogwood fund', path: ['cypress fund', 'beech fund'] },
        { from_key: 'beech fund', to_key: 'dogwood fund', path: ['cypress fund'] },
        { from_key: 'cypress fund', to_key: 'dogwood fund', path: [] },
      ]);
    };
    await chain();
    // Beech, from the middle: Aspen goes back with it; Cypress stays with Dogwood.
    await ok(separate('owner', 'beech fund', 'dogwood fund'));
    expect(await fund()).toEqual([
      { from_key: 'aspen fund', to_key: 'beech fund', path: [] },
      { from_key: 'cypress fund', to_key: 'dogwood fund', path: [] },
    ]);
    expect(await tableTotal('owner', { issuer: 'beech fund' })).toBe(2);
    expect(await tableTotal('owner', { issuer: 'dogwood fund' })).toBe(2);
    await ok(separate('owner', 'cypress fund', 'dogwood fund'));
    await ok(separate('owner', 'aspen fund', 'beech fund'));
    expect(await fund()).toEqual([]);
    await chain();
    // Cypress, the top: Aspen and Beech go back with it, Aspen still remembering Beech.
    await ok(separate('owner', 'cypress fund', 'dogwood fund'));
    expect(await fund()).toEqual([
      { from_key: 'aspen fund', to_key: 'cypress fund', path: ['beech fund'] },
      { from_key: 'beech fund', to_key: 'cypress fund', path: [] },
    ]);
    expect(await tableTotal('owner', { issuer: 'cypress fund' })).toBe(3);
    expect(await tableTotal('owner', { issuer: 'dogwood fund' })).toBe(1);
  });

  it('merges a folder’s pins only up to what a folder holds, and keeps where originals are kept in the folder it joined', async () => {
    await paper('owner', 'Pine statement', 'Pine Bank');
    const filed = await paper('owner', 'Pine savings statement', 'Pine Bank Savings');
    await saved('owner', (await fresh('owner', ['topic', 'person', 'issuer'])).layout);
    const pine = async () =>
      folders((await mine('owner')).layout as CabinetLayout).filter((x) =>
        (x.f.filter.issuer ?? '').startsWith('pine bank'),
      );
    const before = await pine();
    const survivor = before.find((x) => x.f.filter.issuer === 'pine bank')?.f as CabinetFolder;
    const leaving = before.find((x) => x.f.filter.issuer === 'pine bank savings')
      ?.f as CabinetFolder;
    // Where the savings statement is kept: in the savings folder.
    expect(
      (
        await call('owner', 'POST', '/api/v1/documents/original-place', {
          document_ids: [filed],
          folder_id: leaving.id,
        })
      ).statusCode,
    ).toBeLessThan(300);
    // 150 papers pinned into each folder: more than one folder may hold.
    const made = (
      await admin.query<{ id: string }>(
        `insert into document (household_id, title, owner_member_id, type_key, visibility)
         select $1, 'Pinned ' || g, $2, 'bank_statement', 'household'
           from generate_series(1, 300) g
         returning id`,
        [people.owner.household_id, member('owner')],
      )
    ).rows.map((r) => r.id);
    const ours = made.slice(0, 150);
    const theirs = made.slice(150);
    const pin = (folder: string, docs: string[], from: string) =>
      admin.query(
        `insert into cabinet_pin (household_id, member_id, folder_id, document_id, pinned_at)
         select $1, $2, $3, d, $5::timestamptz + (n || ' minutes')::interval
           from unnest($4::uuid[]) with ordinality as x(d, n)`,
        [people.owner.household_id, member('owner'), folder, docs, from],
      );
    await pin(survivor.id, ours, '2025-01-01');
    await pin(leaving.id, theirs, '2026-01-01');

    await ok(same('owner', 'pine bank savings', 'pine bank'));
    expect((await pine()).map((x) => x.f.id)).toEqual([survivor.id]);
    const pins = (
      await admin.query<{ document_id: string }>(
        'select document_id from cabinet_pin where member_id = $1 and folder_id = $2',
        [member('owner'), survivor.id],
      )
    ).rows.map((r) => r.document_id);
    // The survivor's own 150, then the 50 pinned most recently of those moved.
    expect(pins).toHaveLength(200);
    for (const id of ours) expect(pins).toContain(id);
    expect(pins.filter((id) => theirs.includes(id)).sort()).toEqual(theirs.slice(-50).sort());
    const counted = await ok<CabinetCounts>(call('owner', 'GET', '/api/v1/cabinet/counts'));
    expect(counted.pins?.[survivor.id]).toBe(200);
    const opened = await ok<FolderContents>(
      call('owner', 'GET', `/api/v1/cabinet/folders/${survivor.id}`),
    );
    expect(opened.pinned).toHaveLength(200);
    expect(opened.total).toBe(counted.counts[survivor.id]);
    // Still kept where it was: in the folder its own joined, by that folder's names.
    const doc = await ok<{
      original_place: { folder_id: string | null; path: string[] } | null;
    }>(call('owner', 'GET', `/api/v1/documents/${filed}`));
    expect(doc.original_place?.folder_id).toBe(survivor.id);
    expect(doc.original_place?.path[2]).toBe(survivor.name);
    // Read again with nothing changed: the list is only counted, never read again.
    statements.length = 0;
    listening = true;
    await mine('owner');
    listening = false;
    expect(statements.some((q) => q.includes('from "issuer_alias"'))).toBe(false);
    expect(statements.some((q) => /count\(\*\)::int as n, max\(created_at\)/.test(q))).toBe(true);
  });

  it('refuses an issuer the vault would never key', async () => {
    const r = await call('owner', 'GET', '/api/v1/documents?issuer=Not%20A%20Key');
    expect(r.statusCode).toBe(422);
    expect(await tableTotal('owner', { issuer: '_none' })).toBeGreaterThan(0);
  });
});
