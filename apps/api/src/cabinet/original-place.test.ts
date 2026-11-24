import { createDb, createPool, withPrincipal, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  type CabinetLayout,
  type CabinetView,
  type DocumentPage,
  type DocumentView,
  type OriginalPlaceBulkResult,
  type Tokens,
} from '@fdv/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asArranged, createHarness, type Harness } from '../test-harness.js';

/**
 * Where the original is, as a place in somebody's cabinet (0.9.0, C3;
 * 0104): set from the setter's own layout, one document at a time and many
 * at once; read by whoever sees where originals are kept (5.41) and nobody
 * else, found and filtered by its names; following its folder while the
 * folder is its setter's, and kept as words once it is not.
 */

type Person = 'owner' | 'adult' | 'teen' | 'viewer';

describe.skipIf(!testAdminUrl())('where the original is, in a cabinet', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const people = {} as Record<Person, Tokens>;
  const accounts = {} as Record<Person, string>;
  const ids = {} as Record<'deed' | 'bill' | 'samPrivate' | 'tiaReport', string>;

  let nth = 0;
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
      remoteAddress: `10.98.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as T;
  };
  const member = (who: Person) => people[who].member_id;
  /** A response's body, as what it is. */
  const answer = <T>(r: { json: () => unknown }) => r.json() as T;
  const doc = (who: Person, id: string) =>
    ok<DocumentView>(call(who, 'GET', `/api/v1/documents/${id}`));
  const place = (who: Person, id: string, folder: string | null) =>
    call(who, 'PATCH', `/api/v1/documents/${id}`, {
      original_place: folder === null ? null : { folder_id: folder },
    });
  const many = (who: Person, documentIds: string[], folder: string | null) =>
    call(who, 'POST', '/api/v1/documents/original-place', {
      document_ids: documentIds,
      folder_id: folder,
    });
  const save = async (who: Person, layout: CabinetLayout) => {
    const at = await ok<CabinetView>(call(who, 'GET', '/api/v1/cabinet'));
    return ok<CabinetView>(
      call(who, 'PUT', '/api/v1/cabinet', { layout: asArranged(layout), version: at.version }),
    );
  };
  /** A cabinet of one drawer and these folders, the last one hidden when asked. */
  const layout = (
    cabinet: string,
    folders: Array<{ id: string; name: string; hidden?: boolean }>,
  ): CabinetLayout => ({
    levels: null,
    cabinets: [
      {
        id: 'cab',
        name: cabinet,
        hidden: false,
        drawers: [
          {
            id: 'drawer',
            name: 'Drawer 2',
            hidden: false,
            folders: folders.map((f) => ({ hidden: false, filter: {}, ...f })),
          },
        ],
      },
    ],
  });
  const searched = async (who: Person, q: string) =>
    (
      await ok<{ items: Array<{ document_id: string }> }>(
        call(who, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`),
      )
    ).items.map((i) => i.document_id);
  const table = (who: Person, query: string) => call(who, 'GET', `/api/v1/documents?${query}`);
  const lines = async (id: string) =>
    (
      await admin.query<{ detail: Record<string, unknown> }>(
        `select detail from audit_event
          where object_id = $1 and action = 'document.updated' order by id`,
        [id],
      )
    ).rows.map((r) => r.detail);

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 1);
    people.owner = await h.setup({ display_name: 'Olive Khan' });
    people.adult = await h.join(people.owner, {
      name: 'Sam Khan',
      email: 'place-sam@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia Khan',
      email: 'place-tia@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Vic Khan',
      email: 'place-vic@example.test',
      role: 'viewer',
    });
    for (const who of Object.keys(people) as Person[]) {
      accounts[who] = (await ok<{ account_id: string }>(call(who, 'GET', '/api/v1/me'))).account_id;
    }
    const file = async (who: Person, body: object) =>
      (await ok<{ id: string }>(call(who, 'POST', '/api/v1/documents', body))).id;
    ids.deed = await file('owner', {
      title: 'House deed',
      type_key: 'property_deed',
      household_owned: true,
      visibility: 'household',
    });
    ids.bill = await file('owner', {
      title: 'Water bill',
      type_key: 'utility_bill',
      household_owned: true,
      visibility: 'household',
    });
    ids.samPrivate = await file('adult', {
      title: 'Sam’s own statement',
      type_key: 'bank_statement',
      owner_member_id: member('adult'),
      visibility: 'private',
    });
    ids.tiaReport = await file('teen', {
      title: 'Tia’s school report',
      type_key: 'diploma',
      owner_member_id: member('teen'),
      visibility: 'household',
    });
    await save(
      'owner',
      layout('Study lockbox', [
        { id: 'deeds', name: 'Deeds and titles' },
        { id: 'bills', name: 'Bills' },
        { id: 'tucked', name: 'Tucked away', hidden: true },
      ]),
    );
    await save('teen', layout('Tia’s box', [{ id: 'school', name: 'School' }]));
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('says it can', async () => {
    const caps = await ok<{ features: { original_place?: boolean } }>(
      call('owner', 'GET', '/api/v1/capabilities'),
    );
    expect(caps.features.original_place).toBe(true);
  });

  it('is set from the setter’s own shown folder, its names kept, and read by the household alone', async () => {
    const set = await ok<DocumentView>(place('owner', ids.deed, 'deeds'));
    expect(set.original_place).toEqual({
      path: ['Study lockbox', 'Drawer 2', 'Deeds and titles'],
      folder_id: 'deeds',
    });
    // Another member reads the same names, never the setter's folder.
    for (const who of ['adult', 'teen'] as Person[]) {
      expect((await doc(who, ids.deed)).original_place, who).toEqual({
        path: ['Study lockbox', 'Drawer 2', 'Deeds and titles'],
        folder_id: null,
      });
    }
    // A viewer is told nothing of it, nor finds it in the page's words.
    const seen = await call('viewer', 'GET', `/api/v1/documents/${ids.deed}`);
    expect(answer<DocumentView>(seen).original_place).toBeNull();
    expect(seen.body).not.toMatch(/lockbox|Deeds and titles/i);
    // Its line in the log names the field, never the folder.
    const said = await lines(ids.deed);
    expect(said.at(-1)).toEqual({ fields: ['original_place'] });
    expect(JSON.stringify(said)).not.toMatch(/lockbox|Deeds/i);
  });

  it('refuses a folder that is not the caller’s own, a hidden one, a viewer and a teen’s not their own', async () => {
    const theirs = await place('adult', ids.bill, 'deeds');
    expect(theirs.statusCode).toBe(422);
    expect(answer<{ error: { detail?: string } }>(theirs).error.detail).toBe('original_place');
    expect((await place('owner', ids.bill, 'tucked')).statusCode).toBe(422);
    expect((await place('viewer', ids.bill, null)).statusCode).toBe(403);
    expect((await place('teen', ids.bill, 'school')).statusCode).toBe(403);
    // Nor is it taken on a new document.
    const made = await call('owner', 'POST', '/api/v1/documents', {
      title: 'Not like this',
      original_place: { folder_id: 'deeds' },
    });
    expect(made.statusCode).toBe(422);
    expect((await doc('owner', ids.bill)).original_place).toBeNull();
    // A teen files their own in their own cabinet.
    const hers = await ok<DocumentView>(place('teen', ids.tiaReport, 'school'));
    expect(hers.original_place?.path).toEqual(['Tia’s box', 'Drawer 2', 'School']);
  });

  it('is found by its words for the household, and never by a viewer, nor hidden from one', async () => {
    expect(await searched('owner', 'lockbox')).toContain(ids.deed);
    expect(await searched('adult', 'Deeds titles')).toContain(ids.deed);
    expect(await searched('viewer', 'lockbox')).toEqual([]);
    expect(await searched('viewer', 'deed -lockbox')).toContain(ids.deed);
  });

  it('sorts and filters the table by it, for whoever sees where originals are kept', async () => {
    await ok(place('owner', ids.bill, 'bills'));
    for (const asked of [
      'Study lockbox › Drawer 2 › Deeds and titles',
      'study LOCKBOX › drawer 2 › deeds and titles',
    ]) {
      const page = await ok<DocumentPage>(
        table('adult', `sort=title&original_place=${encodeURIComponent(asked)}`),
      );
      expect(page.items.map((d) => d.id)).toEqual([ids.deed]);
    }
    // A cabinet, or a cabinet and its drawer: everything inside.
    const inside = await ok<DocumentPage>(
      table('owner', `sort=original_place&original_place=${encodeURIComponent('Study lockbox')}`),
    );
    expect(inside.items.map((d) => d.id)).toEqual([ids.bill, ids.deed]);
    // A name is not a prefix of another's: "Study" alone is no cabinet here.
    const partial = await ok<DocumentPage>(
      table('owner', `sort=title&original_place=${encodeURIComponent('Study')}`),
    );
    expect(partial.items).toEqual([]);
    // By the names as one line, and those with none last, either way.
    const sorted = await ok<DocumentPage>(table('owner', 'sort=original_place&direction=desc'));
    expect(sorted.items.slice(0, 3).map((d) => d.id)).toEqual([ids.tiaReport, ids.deed, ids.bill]);
    expect(sorted.items.slice(3).every((d) => d.original_place === null)).toBe(true);
    for (const q of ['sort=original_place', 'sort=title&original_place=Study%20lockbox']) {
      expect((await table('viewer', q)).statusCode, q).toBe(422);
    }
    // With an older sort, it goes with a column's.
    expect((await table('owner', 'original_place=Study%20lockbox')).statusCode).toBe(422);
  });

  it('follows its folder renamed or moved, keeps its names once the folder is gone, and moves nobody’s edit', async () => {
    const before = await doc('owner', ids.deed);
    await save(
      'owner',
      layout('Study lockbox', [
        { id: 'deeds', name: 'Deeds' },
        { id: 'bills', name: 'Bills' },
      ]),
    );
    const renamed = await doc('adult', ids.deed);
    expect(renamed.original_place?.path).toEqual(['Study lockbox', 'Drawer 2', 'Deeds']);
    // Nobody's edit: its version and its log are as they were.
    expect(renamed.etag).toBe(before.etag);
    expect((await lines(ids.deed)).length).toBe(1);
    // Somebody else's layout changes nothing of the owner's places.
    await save('adult', layout('Sam’s drawer', [{ id: 'deeds', name: 'Sam’s deeds' }]));
    expect((await doc('owner', ids.deed)).original_place?.path).toEqual([
      'Study lockbox',
      'Drawer 2',
      'Deeds',
    ]);
    // The folder taken away: the names stay, as words, its folder let go.
    await save('owner', layout('Study lockbox', [{ id: 'bills', name: 'Bills' }]));
    expect((await doc('owner', ids.deed)).original_place).toEqual({
      path: ['Study lockbox', 'Drawer 2', 'Deeds'],
      folder_id: null,
    });
    // And a folder of the same id made again is not taken to be it.
    await save(
      'owner',
      layout('Study lockbox', [
        { id: 'bills', name: 'Bills' },
        { id: 'deeds', name: 'New deeds' },
      ]),
    );
    expect((await doc('owner', ids.deed)).original_place?.path).toEqual([
      'Study lockbox',
      'Drawer 2',
      'Deeds',
    ]);
  });

  it('is set and cleared for many at once, rows held in id order, a line a document', async () => {
    const both = await ok<OriginalPlaceBulkResult>(many('owner', [ids.deed, ids.bill], 'bills'));
    expect(both).toEqual({ changed: [ids.deed], unchanged: [ids.bill], not_yours: [] });
    expect((await lines(ids.deed)).at(-1)).toEqual({ fields: ['original_place'] });
    // A teen: their own changed, the rest named and left as they are.
    const teen = await ok<OriginalPlaceBulkResult>(
      many('teen', [ids.tiaReport, ids.bill], 'school'),
    );
    expect(teen).toEqual({ changed: [], unchanged: [ids.tiaReport], not_yours: [ids.bill] });
    expect((await doc('owner', ids.bill)).original_place?.path).toEqual([
      'Study lockbox',
      'Drawer 2',
      'Bills',
    ]);
    // One they may not see: nothing is changed, and nothing said of it.
    const unseen = await many('owner', [ids.bill, ids.samPrivate], null);
    expect(unseen.statusCode).toBe(404);
    expect((await doc('owner', ids.bill)).original_place).not.toBeNull();
    expect((await many('viewer', [ids.bill], null)).statusCode).toBe(403);
    expect((await many('owner', [ids.bill], 'nope')).statusCode).toBe(422);
    const cleared = await ok<OriginalPlaceBulkResult>(many('owner', [ids.bill, ids.deed], null));
    expect([...cleared.changed].sort()).toEqual([ids.bill, ids.deed].sort());
    expect((await doc('adult', ids.deed)).original_place).toBeNull();
  });

  describe('after its review', () => {
    const owners = (folders: Array<{ id: string; name: string; hidden?: boolean }>) =>
      save('owner', layout('Study lockbox', folders));
    const now = async () =>
      (await admin.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]?.t as Date;

    it('a list since a folder was renamed gives a phone the new names, its ETag as it was', async () => {
      await owners([{ id: 'bills', name: 'Bills' }]);
      const placed = await ok<DocumentView>(place('owner', ids.bill, 'bills'));
      const since = (await now()).toISOString();
      await owners([{ id: 'bills', name: 'Bills paid' }]);
      const older = await ok<DocumentPage>(
        call('adult', 'GET', `/api/v1/documents?updated_since=${encodeURIComponent(since)}`),
      );
      const found = older.items.find((d) => d.id === ids.bill);
      expect(found?.original_place?.path).toEqual(['Study lockbox', 'Drawer 2', 'Bills paid']);
      expect(found?.etag).toBe(placed.etag);
      // Nothing else of the household's moved.
      expect(older.items.map((d) => d.id)).not.toContain(ids.deed);
      const tabled = await ok<DocumentPage>(
        table('adult', `sort=title&updated_since=${encodeURIComponent(since)}`),
      );
      expect(tabled.items.map((d) => d.id)).toEqual([ids.bill]);
    });

    it('lets a folder hidden, or in a hidden drawer, go: its last shown names kept', async () => {
      await owners([{ id: 'bills', name: 'Secret bills', hidden: true }]);
      expect((await doc('owner', ids.bill)).original_place).toEqual({
        path: ['Study lockbox', 'Drawer 2', 'Bills paid'],
        folder_id: null,
      });
      // Shown again, it is not taken back: the paper is filed in it again by hand.
      await owners([{ id: 'bills', name: 'Bills' }]);
      await ok(place('owner', ids.bill, 'bills'));
      const hiddenDrawer = layout('Study lockbox', [{ id: 'bills', name: 'Bills renamed' }]);
      const drawer = hiddenDrawer.cabinets[0]?.drawers[0];
      if (drawer) drawer.hidden = true;
      await save('owner', hiddenDrawer);
      expect((await doc('adult', ids.bill)).original_place?.path).toEqual([
        'Study lockbox',
        'Drawer 2',
        'Bills',
      ]);
    });

    it('keeps names trimmed, so spaces before a name never make a save fail', async () => {
      const padded = `${' '.repeat(250)}Receipts`;
      await owners([{ id: 'rcpt', name: padded }]);
      await ok(place('owner', ids.bill, 'rcpt'));
      expect((await doc('owner', ids.bill)).original_place?.path).toEqual([
        'Study lockbox',
        'Drawer 2',
        'Receipts',
      ]);
      const again = await owners([{ id: 'rcpt', name: padded }]);
      expect(again.layout?.cabinets[0]?.drawers[0]?.folders[0]?.name).toBe('Receipts');
    });

    it('refuses " › " in a new name, and keeps one a name had before', async () => {
      const at = await ok<CabinetView>(call('owner', 'GET', '/api/v1/cabinet'));
      const joined = await call('owner', 'PUT', '/api/v1/cabinet', {
        layout: asArranged(layout('Study lockbox', [{ id: 'rcpt', name: 'Tax › 2025' }])),
        version: at.version,
      });
      expect(joined.statusCode).toBe(422);
      expect(joined.body).toContain('“ › ”');
      // Kept before (a layout saved by an older build): saved again as it was.
      const kept = asArranged(layout('Study lockbox', [{ id: 'rcpt', name: 'Old › name' }]));
      await admin.query('update cabinet_layout set layout = $1::jsonb where member_id = $2', [
        JSON.stringify(kept),
        member('owner'),
      ]);
      expect((await save('owner', kept)).layout?.cabinets[0]?.drawers[0]?.folders[0]?.name).toBe(
        'Old › name',
      );
      await owners([{ id: 'bills', name: 'Bills' }]);
    });

    it('leaves a paper read as its person’s caregiver as it is, and names it', async () => {
      const medical = await ok<{ id: string }>(
        call('adult', 'POST', '/api/v1/documents', {
          title: 'Sam’s clinic letter',
          type_key: 'medical_record',
          owner_member_id: member('adult'),
          visibility: 'private',
        }),
      );
      await ok(
        call('adult', 'POST', `/api/v1/members/${member('adult')}/caregivers`, {
          caregiver_member_id: member('owner'),
        }),
      );
      const done = await ok<OriginalPlaceBulkResult>(
        many('owner', [ids.bill, medical.id], 'bills'),
      );
      expect(done.not_yours).toEqual([medical.id]);
      expect(
        (
          await admin.query<{ original_place: string[] | null }>(
            'select original_place from document where id = $1',
            [medical.id],
          )
        ).rows[0]?.original_place,
      ).toBeNull();
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
    beforeAll(() => {
      one = createDb(createPool(h.appUrl, 1));
    });
    afterAll(async () => {
      await one.destroy();
    });
    const write = (who: Person, by: Person, names = ['A', 'B', 'C']) =>
      withPrincipal(one, principal(who), (trx) =>
        sql`update document
               set original_place = ${names}::text[],
                   original_place_by = ${member(by)}::uuid,
                   original_place_folder = 'deeds'
             where id = ${ids.deed}::uuid`.execute(trx),
      ).then(
        () => 'written',
        (e: { code?: string }) => e.code ?? 'error',
      );

    it('lets nobody point at somebody else’s folder, nor a viewer write a place', async () => {
      // Sam's layout has a folder `deeds` too: still never the owner's to name.
      expect(await write('owner', 'adult')).toBe('42501');
      expect(await write('viewer', 'viewer')).toBe('42501');
      expect(await write('owner', 'owner')).toBe('written');
      // Nor are its names somebody else's to change while it is the owner's.
      expect(
        await withPrincipal(one, principal('adult'), (trx) =>
          sql`update document set original_place = array['X', 'Y', 'Z']
               where id = ${ids.deed}::uuid`.execute(trx),
        ).then(
          () => 'written',
          (e: { code?: string }) => e.code ?? 'error',
        ),
      ).toBe('42501');
      // A place as a whole is anybody's who may change it: replaced, or cleared.
      expect(await write('adult', 'adult')).toBe('written');
      const cleared = await withPrincipal(one, principal('owner'), (trx) =>
        sql`update document
               set original_place = null, original_place_by = null, original_place_folder = null
             where id = ${ids.deed}::uuid`.execute(trx),
      );
      expect(Number(cleared.numAffectedRows)).toBe(1);
    });

    it('keeps the names as words when the setter’s layout goes, its folder with it', async () => {
      await ok(place('teen', ids.tiaReport, 'school'));
      await admin.query('delete from cabinet_layout where member_id = $1', [member('teen')]);
      const { rows } = await admin.query<{
        original_place: string[] | null;
        original_place_by: string | null;
        original_place_folder: string | null;
      }>(
        'select original_place, original_place_by, original_place_folder from document where id = $1',
        [ids.tiaReport],
      );
      expect(rows[0]).toEqual({
        original_place: ['Tia’s box', 'Drawer 2', 'School'],
        original_place_by: null,
        original_place_folder: null,
      });
    });
  });
});
