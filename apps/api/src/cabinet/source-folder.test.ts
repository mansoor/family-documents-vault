import { randomUUID } from 'node:crypto';
import { createDb, createPool, withPrincipal, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  FOLDERS_CABINET,
  type BatchDetail,
  type BatchItemView,
  type CabinetCounts,
  type CabinetFromFolders,
  type CabinetLayout,
  type CabinetView,
  type DocumentPage,
  type DocumentView,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Bring your tree (0.9.0, C4; 0105): the folder a paper came from — Add →
 * Many documents with a folder, the scanner folder, a paired computer — kept
 * on the document as it is filed from its batch's item; read, found and
 * filtered by whoever sees where originals are kept (5.41) and nobody else;
 * forgotten, never written; and drawn into its filer's own cabinet beside
 * what is there, kept only when they save it.
 */

type Person = 'owner' | 'adult' | 'teen' | 'viewer';

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${randomUUID()}\n%%EOF\n`);

describe.skipIf(!testAdminUrl())('the folder a paper came from (C4)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const people = {} as Record<Person, Tokens>;
  const accounts = {} as Record<Person, string>;
  const ids = {} as Record<
    'w2' | 'w2Again' | 'loose' | 'water' | 'none' | 'adults' | 'versioned',
    string
  >;

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
      remoteAddress: `10.97.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as T;
  };
  const doc = (who: Person, id: string) =>
    ok<DocumentView>(call(who, 'GET', `/api/v1/documents/${id}`));
  const table = (who: Person, query: string) => call(who, 'GET', `/api/v1/documents?${query}`);
  const searched = async (who: Person, q: string) =>
    (
      await ok<{ items: Array<{ document_id: string }> }>(
        call(who, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`),
      )
    ).items.map((i) => i.document_id);
  /** A file sent into a batch from a folder, as Add → Many documents sends one. */
  const sent = async (who: Person, batchId: string, path?: string) => {
    const form = new FormData();
    if (path !== undefined) form.append('relative_path', path);
    // Named as the path's last part is, as a browser sends a folder's file.
    const filename = path?.split('/').at(-1) ?? 'scan.pdf';
    form.append('file', PDF('tree'), { filename, contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batchId}/items`,
      headers: { ...h.as(people[who]), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<BatchItemView>();
  };
  /** Filed as a new document of the household's, with this title. */
  const filed = async (who: Person, batchId: string, path: string | undefined, title: string) => {
    const item = await sent(who, batchId, path);
    return (
      await ok<{ document_id: string }>(
        call(who, 'POST', `/api/v1/batches/${batchId}/items/${item.id}/accept`, {
          title,
          type_key: 'utility_bill',
          household_owned: true,
          visibility: 'household',
        }),
      )
    ).document_id;
  };
  const drawn = (who: Person) => call(who, 'GET', '/api/v1/cabinet/from-folders');
  const lines = async (id: string) =>
    (
      await admin.query<{ detail: Record<string, unknown> }>(
        `select detail from audit_event
          where object_id = $1 and action = 'document.updated' order by id`,
        [id],
      )
    ).rows.map((r) => r.detail);
  const mine: CabinetLayout = {
    levels: null,
    cabinets: [
      {
        id: 'mine',
        name: 'Study',
        hidden: false,
        drawers: [
          {
            id: 'top',
            name: 'Top drawer',
            hidden: false,
            folders: [{ id: 'bills', name: 'Bills', hidden: false, filter: { category: 'bills' } }],
          },
        ],
      },
    ],
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 1);
    people.owner = await h.setup({ display_name: 'Olive Khan' });
    people.adult = await h.join(people.owner, {
      name: 'Sam Khan',
      email: 'tree-sam@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia Khan',
      email: 'tree-tia@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Vic Khan',
      email: 'tree-vic@example.test',
      role: 'viewer',
    });
    for (const who of Object.keys(people) as Person[]) {
      accounts[who] = (await ok<{ account_id: string }>(call(who, 'GET', '/api/v1/me'))).account_id;
    }
    const b = await ok<BatchDetail>(call('owner', 'POST', '/api/v1/batches', { name: 'Olive’s' }));
    ids.w2 = await filed('owner', b.id, 'Taxes/2025/w2.pdf', 'Acme slip');
    ids.w2Again = await filed('owner', b.id, 'taxes/2025/w2-copy.pdf', 'Acme slip copy');
    ids.loose = await filed('owner', b.id, 'Taxes/letter.pdf', 'Revenue letter');
    ids.water = await filed('owner', b.id, 'Bills/Water/2026/q1.pdf', 'Quarter one');
    ids.none = await filed('owner', b.id, undefined, 'Loose page');
    const theirs = await ok<BatchDetail>(
      call('adult', 'POST', '/api/v1/batches', { name: 'Sam’s' }),
    );
    ids.adults = await filed('adult', theirs.id, 'Sam box/one.pdf', 'Sam’s page');
    await ok(call('owner', 'PUT', '/api/v1/cabinet', { layout: mine, version: 0 }));
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('says it can', async () => {
    const caps = await ok<{ features: { source_folders?: boolean } }>(
      call('owner', 'GET', '/api/v1/capabilities'),
    );
    expect(caps.features.source_folders).toBe(true);
  });

  it('is kept on the document filed from a folder, and read by the household alone', async () => {
    expect((await doc('owner', ids.w2)).source_folder).toBe('Taxes/2025');
    expect((await doc('owner', ids.water)).source_folder).toBe('Bills/Water/2026');
    expect((await doc('owner', ids.none)).source_folder).toBeNull();
    for (const who of ['adult', 'teen'] as Person[]) {
      expect((await doc(who, ids.w2)).source_folder, who).toBe('Taxes/2025');
    }
    // A viewer is told nothing of it.
    const seen = await call('viewer', 'GET', `/api/v1/documents/${ids.w2}`);
    expect(seen.json<DocumentView>().source_folder).toBeNull();
    expect(seen.body).not.toMatch(/Taxes/);
    // Nor in a list.
    const listed = await ok<{ items: DocumentView[] }>(call('viewer', 'GET', '/api/v1/documents'));
    expect(listed.items.find((d) => d.id === ids.w2)?.source_folder).toBeNull();
  });

  it('is left as it is when a file from another folder is added as a new version', async () => {
    const b = await ok<BatchDetail>(call('owner', 'POST', '/api/v1/batches', { name: 'Again' }));
    const item = await sent('owner', b.id, 'Elsewhere/again.pdf');
    await ok(
      call('owner', 'POST', `/api/v1/batches/${b.id}/items/${item.id}/accept`, {
        into_document_id: ids.water,
      }),
    );
    expect((await doc('owner', ids.water)).source_folder).toBe('Bills/Water/2026');
  });

  it('filters the table by the folder exactly, whatever the case, for whoever sees where originals are kept', async () => {
    const page = await ok<DocumentPage>(
      table('adult', `sort=title&source_folder=${encodeURIComponent('TAXES/2025')}`),
    );
    expect(page.items.map((d) => d.id).sort()).toEqual([ids.w2, ids.w2Again].sort());
    // The folder alone, never those inside it.
    const top = await ok<DocumentPage>(table('owner', 'sort=title&source_folder=Taxes'));
    expect(top.items.map((d) => d.id)).toEqual([ids.loose]);
    expect((await table('viewer', 'sort=title&source_folder=Taxes')).statusCode).toBe(422);
    // With an older sort, it goes with a column's.
    expect((await table('owner', 'source_folder=Taxes')).statusCode).toBe(422);
  });

  it('is found by its words for the household, and never by a viewer', async () => {
    expect(await searched('owner', 'Taxes')).toEqual(expect.arrayContaining([ids.w2, ids.loose]));
    expect(await searched('adult', 'Water')).toContain(ids.water);
    expect(await searched('viewer', 'Taxes')).toEqual([]);
  });

  it('draws the caller’s own folders into their cabinet, beside what is there, and saves nothing', async () => {
    const before = await ok<CabinetView>(call('owner', 'GET', '/api/v1/cabinet'));
    // Asked cheaply with the counts: there are folders to add.
    const told = await ok<CabinetCounts>(call('owner', 'GET', '/api/v1/cabinet/counts'));
    expect(told.new_folders).toBe(true);
    // A viewer is told nothing of them; a teen who filed none, none.
    expect(
      (await ok<CabinetCounts>(call('viewer', 'GET', '/api/v1/cabinet/counts'))).new_folders,
    ).toBeUndefined();
    expect(
      (await ok<CabinetCounts>(call('teen', 'GET', '/api/v1/cabinet/counts'))).new_folders,
    ).toBe(false);
    const got = await ok<CabinetFromFolders>(drawn('owner'));
    expect(got.version).toBe(before.version);
    // Only the folders the owner filed from; one folder whatever its case.
    expect(got.folders.map((f) => [f.path.toLowerCase(), f.documents])).toEqual([
      ['bills/water/2026', 1],
      ['taxes', 1],
      ['taxes/2025', 2],
    ]);
    // What was there, as it was; and "My folders" beside it.
    expect(got.layout.cabinets[0]).toEqual(mine.cabinets[0]);
    const tree = got.layout.cabinets[1];
    expect(tree?.name).toBe(FOLDERS_CABINET);
    expect(tree?.drawers.map((d) => [d.name, d.folders.map((f) => [f.name, f.filter])])).toEqual([
      ['Bills', [['Water / 2026', { source_folder: 'Bills/Water/2026', notes: 'exclude' }]]],
      [
        'Taxes',
        [
          ['Taxes', { source_folder: 'Taxes', notes: 'exclude' }],
          [
            '2025',
            {
              source_folder: expect.stringMatching(/^taxes\/2025$/i) as unknown,
              notes: 'exclude',
            },
          ],
        ],
      ],
    ]);
    expect(got.added).toEqual({ cabinets: 1, drawers: 2, folders: 3 });
    expect(got.already).toBe(0);
    expect(got.left_out).toBe(0);
    // Nothing kept until it is saved.
    expect(await ok<CabinetView>(call('owner', 'GET', '/api/v1/cabinet'))).toEqual(before);

    // Kept to the version it was drawn on; its folders fill themselves.
    const kept = await ok<CabinetView>(
      call('owner', 'PUT', '/api/v1/cabinet', { layout: got.layout, version: got.version }),
    );
    const counts = await ok<CabinetCounts>(call('owner', 'GET', '/api/v1/cabinet/counts'));
    expect(counts.new_folders).toBe(false);
    for (const [id, n] of Object.entries(got.counts)) expect(counts.counts[id], id).toBe(n);
    // Never over a cabinet changed since.
    const stale = await call('owner', 'PUT', '/api/v1/cabinet', {
      layout: got.layout,
      version: got.version,
    });
    expect(stale.statusCode).toBe(409);
    // Drawn again: nothing new.
    const again = await ok<CabinetFromFolders>(drawn('owner'));
    expect(again.version).toBe(kept.version);
    expect(again.added).toEqual({ cabinets: 0, drawers: 0, folders: 0 });
    expect(again.already).toBe(3);
    expect(again.layout).toEqual(kept.layout);
    // Somebody else's folders are theirs: the adult's own, a teen's none.
    expect((await ok<CabinetFromFolders>(drawn('adult'))).folders).toEqual([
      { path: 'Sam box', documents: 1 },
    ]);
    expect((await ok<CabinetFromFolders>(drawn('teen'))).folders).toEqual([]);
  });

  it('is never asked by a viewer: neither drawn nor saved in their cabinet', async () => {
    expect((await drawn('viewer')).statusCode).toBe(403);
    const saved = await call('viewer', 'PUT', '/api/v1/cabinet', {
      version: 0,
      layout: {
        levels: null,
        cabinets: [
          {
            id: 'c',
            name: 'Mine',
            hidden: false,
            drawers: [
              {
                id: 'd',
                name: 'Drawer',
                hidden: false,
                folders: [
                  { id: 'f', name: 'Taxes', hidden: false, filter: { source_folder: 'Taxes' } },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(saved.statusCode).toBe(422);
  });

  it('is forgotten by whoever may change the document, never written, and never by a viewer', async () => {
    const written = await call('adult', 'PATCH', `/api/v1/documents/${ids.loose}`, {
      source_folder: 'Somewhere else',
    });
    expect(written.statusCode).toBe(422);
    expect(
      (await call('viewer', 'PATCH', `/api/v1/documents/${ids.loose}`, { source_folder: null }))
        .statusCode,
    ).toBe(403);
    // Nor taken on a new document.
    const made = await call('owner', 'POST', '/api/v1/documents', {
      title: 'Not like this',
      source_folder: 'Taxes',
    });
    expect(made.statusCode).toBe(422);
    const forgotten = await ok<DocumentView>(
      call('adult', 'PATCH', `/api/v1/documents/${ids.loose}`, { source_folder: null }),
    );
    expect(forgotten.source_folder).toBeNull();
    // Its line in the log names the field, never the folder.
    const said = await lines(ids.loose);
    expect(said.at(-1)).toEqual({ fields: ['source_folder'] });
    expect(JSON.stringify(said)).not.toMatch(/Taxes/);
  });

  it('says how many folders it did not read, past the most it reads at once', async () => {
    // 2,001 folders more, filed by the owner, as filing them from a batch keeps them.
    await admin.query(
      `insert into document (household_id, title, type_key, household_owned, visibility,
                             created_by, updated_by, source_folder)
       select $1, 'Bulk ' || g, 'utility_bill', true, 'household', $2, $2, 'Bulk/' || g
         from generate_series(1, 2001) g`,
      [people.owner.household_id, accounts.owner],
    );
    try {
      const total = Number(
        (
          await admin.query<{ n: string }>(
            `select count(distinct lower(source_folder)) as n from document
              where household_id = $1 and deleted_at is null and source_folder is not null
                and created_by = $2`,
            [people.owner.household_id, accounts.owner],
          )
        ).rows[0]?.n,
      );
      expect(total).toBeGreaterThan(2000);
      const got = await ok<CabinetFromFolders>(drawn('owner'));
      expect(got.folders).toHaveLength(2000);
      // Every folder is drawn, there already, or said to be left out.
      expect(got.added.folders + got.already + got.left_out).toBe(total);
      expect(got.left_out).toBeGreaterThan(0);
    } finally {
      await admin.query(`delete from document where household_id = $1 and title like 'Bulk %'`, [
        people.owner.household_id,
      ]);
    }
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
    const write = (who: Person, id: string, to: string | null) =>
      withPrincipal(one, principal(who), (trx) =>
        sql`update document set source_folder = ${to} where id = ${id}::uuid`.execute(trx),
      ).then(
        () => 'written',
        (e: { code?: string }) => e.code ?? 'error',
      );

    it('keeps it as it came, or forgotten: never another folder', async () => {
      expect(await write('owner', ids.water, 'Bills/Gas')).toBe('42501');
      expect(await write('owner', ids.none, 'Bills')).toBe('42501');
      expect(await write('owner', ids.water, null)).toBe('written');
    });

    it('holds its shape: no folder of nothing, nor a path that starts or ends with "/"', async () => {
      for (const bad of ['', '/Taxes', 'Taxes/', 'Taxes//2025', ' Taxes']) {
        await expect(
          admin.query('update document set source_folder = $1 where id = $2', [bad, ids.none]),
        ).rejects.toMatchObject({ code: '23514' });
      }
    });
  });
});
