import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { testAdminUrl } from '@fdv/db/testing';
import {
  issuerKey,
  numberKey,
  proposeDetails,
  suggestFromFolder,
  type DocumentTypeView,
  type ProposalPerson,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './test-harness.js';

const run = promisify(execFile);
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'demo-seed.mjs',
);

/** The lines a PDF demo-seed made carries: its text is `(…) Tj`, one a line. */
const linesOf = (pdf: Buffer): string[] =>
  [...pdf.toString('latin1').matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)].map((m) =>
    (m[1] as string).replace(/\\(.)/g, '$1'),
  );

/**
 * scripts/demo-seed.mjs against a vault of this release (the Phase 6 exit):
 * it fills a new vault as the demonstration's runbook says, and its --out
 * folder holds the files the review queue is shown with — a duplicate, a
 * blank page, and four letters from one sender that name nobody, from
 * which the vault learns.
 */
describe.skipIf(!testAdminUrl())('demo-seed.mjs', () => {
  let h: Harness;
  let port = 0;
  let out = '';
  const owner = { email: 'olivia-seed@example.test', password: `${randomUUID()}-seed` };

  beforeAll(async () => {
    h = await createHarness();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    port = (h.app.server.address() as AddressInfo).port;
    out = await mkdtemp(path.join(tmpdir(), 'fdv-demo-seed-'));
  }, 120_000);
  afterAll(async () => {
    await h?.close();
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('fills a new vault, and writes the files for the review queue', async () => {
    const { stdout } = await run(
      process.execPath,
      [
        SCRIPT,
        '--url',
        `http://127.0.0.1:${port}`,
        '--email',
        owner.email,
        '--password',
        owner.password,
        '--out',
        out,
      ],
      { timeout: 120_000 },
    );
    expect(stdout).toContain('set up "The Khan family" with Olivia as its owner');
    // Where two-step sign-in is now: Settings → Your account (R1).
    expect(stdout).toContain('Settings → Your account → Two-step sign-in');

    // The vault as the runbook needs it.
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: owner,
    });
    const t = signedIn.json<Tokens>();
    const get = async <T>(url: string) => (await h.app.inject({ url, headers: h.as(t) })).json<T>();
    const people = await get<{
      items: Array<{
        id: string;
        display_name: string;
        date_of_birth: string | null;
        has_account: boolean;
      }>;
    }>('/api/v1/members');
    expect(people.items.map((m) => m.display_name).sort()).toEqual([
      'Ahmed',
      'Granny Farida',
      'Maryam',
      'Olivia',
      'Sara',
      'Tariq',
      'Vera',
    ]);
    // The family with no sign-in, for inviting (the 0.8.0 exit): a child too
    // young for one, a grandmother, and Sara, 13 today — whom the owners are
    // reminded about, and who may be invited as a teen alone.
    const born = (name: string) => people.items.find((m) => m.display_name === name);
    const today = new Date();
    const thirteen = `${today.getUTCFullYear() - 13}-${today.toISOString().slice(5, 10)}`;
    expect(
      ['Maryam', 'Granny Farida', 'Sara'].map((n) => [
        n,
        born(n)?.date_of_birth?.slice(0, 10),
        born(n)?.has_account,
      ]),
    ).toEqual([
      ['Maryam', '2017-07-09', false],
      ['Granny Farida', '1953-08-30', false],
      ['Sara', thirteen, false],
    ]);
    expect(stdout).toContain('With no sign-in (to invite, or not):');
    // The country the papers' dates are written for, with --corpus or not,
    // so scripts/smart-corpus.mjs's papers are read as the UK writes them.
    expect((await get<{ country: string | null }>('/api/v1/profile')).country).toBe('GB');
    const docs = await get<{
      items: Array<{ id: string; title: string | null; identifier?: string | null }>;
    }>('/api/v1/documents?limit=200');
    expect(docs.items.map((d) => d.title).sort()).toEqual([
      'A scan from the printer',
      'Ahmed passport',
      'Ahmed tax return 2025',
      'Ahmed tax return 2025, the adults’ copy',
      'Car insurance',
      'House deed, 14 Elm Street',
      "Olivia's will",
    ]);
    const collections = await get<{ items: Array<{ name: string }> }>('/api/v1/collections');
    expect(collections.items.map((c) => c.name)).toContain('For the attorney');

    // The files: each a PDF, and those the queue is shown with — in the
    // folders a family keeps (0.8.0, S2).
    const names = (await readdir(out, { recursive: true }))
      .map((n) => String(n).split(path.sep).join('/'))
      .filter((n) => n.endsWith('.pdf'))
      .sort();
    expect(names).toEqual([
      'Ahmed/Passport/passport-scan.pdf',
      'Bills/2026/electricity-bill.pdf',
      'Insurance/car-insurance-again.pdf',
      'Insurance/car-insurance-renewal.pdf',
      'Letters/clinic-letter-1.pdf',
      'Letters/clinic-letter-2.pdf',
      'Letters/clinic-letter-3.pdf',
      'Letters/clinic-letter-4.pdf',
      'Tariq/Passport/tariq-passport.pdf',
      'blank-page.pdf',
    ]);
    const file = (name: string) => readFile(path.join(out, ...name.split('/')));
    for (const name of names) expect((await file(name)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(linesOf(await file('blank-page.pdf'))).toEqual([]);

    // The copy of the car insurance, and the scanned page, are each a
    // duplicate of a document filed, to the vault: in a batch, it says so.
    // Tariq's passport is nobody's duplicate.
    const batch = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/batches',
        headers: h.as(t),
        payload: { name: 'From the runbook' },
      })
    ).json<{ id: string }>();
    const add = async (name: string) => {
      const form = new FormData();
      const bytes = await file(name);
      // Where it was, as Choose a folder sends it (S2).
      form.append('relative_path', name);
      form.append('file', bytes, {
        filename: path.posix.basename(name),
        contentType: 'application/pdf',
      });
      const item = await h.app.inject({
        method: 'POST',
        url: `/api/v1/batches/${batch.id}/items`,
        headers: { ...h.as(t), ...form.getHeaders() },
        payload: form.getBuffer(),
      });
      expect(item.statusCode, item.body).toBe(201);
      const got = item.json<{ sha256: string; duplicate: unknown; folder: string | null }>();
      expect(got.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      return got;
    };
    const idOf = (title: string) => docs.items.find((d) => d.title === title)?.id;
    expect((await add('Insurance/car-insurance-again.pdf')).duplicate).toMatchObject({
      of: 'document',
      document_id: idOf('Car insurance'),
    });
    expect((await add('Ahmed/Passport/passport-scan.pdf')).duplicate).toMatchObject({
      of: 'document',
      document_id: idOf('A scan from the printer'),
    });
    const tariqItem = await add('Tariq/Passport/tariq-passport.pdf');
    expect(tariqItem.duplicate).toBeNull();
    // Where it came from is kept with it, for the uploader (S2).
    expect(tariqItem.folder).toBe('Tariq/Passport');
    expect((await add('Bills/2026/electricity-bill.pdf')).folder).toBe('Bills/2026');

    // What the worker reads off them, as it proposes (I2).
    const types = await get<{ items: DocumentTypeView[] }>('/api/v1/document-types');
    const family: ProposalPerson[] = people.items.map((m) => ({ id: m.id, name: m.display_name }));
    const propose = async (name: string) =>
      proposeDetails(linesOf(await file(name)).join('\n'), {
        types: types.items,
        people: family,
        household: 'The Khan family',
        dateOrder: 'dmy',
      });
    // Tariq's passport: what it is and whose, its dates and number — Ready.
    const tariq = people.items.find((m) => m.display_name === 'Tariq');
    expect(await propose('Tariq/Passport/tariq-passport.pdf')).toMatchObject({
      type_key: { value: 'passport' },
      owner_member_id: { value: tariq?.id },
      issued: { value: { date: '2022-08-02' } },
      expires: { value: { date: '2027-08-02' } },
      identifier: { value: '548812306' },
    });
    // And its folder says the same (S2).
    const folderSays = (name: string) =>
      suggestFromFolder(path.posix.dirname(name), { types: types.items, people: family });
    expect(folderSays('Tariq/Passport/tariq-passport.pdf')).toMatchObject({
      type_key: 'passport',
      owner_member_id: tariq?.id,
    });
    // The bill: its folder says what it is, its pages whose.
    const olivia = people.items.find((m) => m.display_name === 'Olivia');
    expect(folderSays('Bills/2026/electricity-bill.pdf')).toMatchObject({
      type_key: 'utility_bill',
      owner_member_id: null,
    });
    expect(await propose('Bills/2026/electricity-bill.pdf')).toMatchObject({
      owner_member_id: { value: olivia?.id },
    });
    // Next year's car insurance (0.8.0, S1): nobody's duplicate, and read as
    // the same kind and policy number as the one filed — what makes its card
    // offer "Add as a new version of Car insurance" — with new dates.
    expect((await add('Insurance/car-insurance-renewal.pdf')).duplicate).toBeNull();
    const car = await get<{ identifier: string | null; expires: { date: string } | null }>(
      `/api/v1/documents/${idOf('Car insurance')}`,
    );
    const renewal = await propose('Insurance/car-insurance-renewal.pdf');
    expect(renewal).toMatchObject({
      type_key: { value: 'insurance_policy' },
      owner_member_id: { value: olivia?.id },
    });
    expect(numberKey(renewal.identifier?.value ?? '')).toBe(numberKey(car.identifier ?? '-'));
    expect((renewal.expires?.value.date ?? '') > (car.expires?.date ?? '9999')).toBe(true);
    // The four letters: the same sender read off each, and nothing else,
    // so what and whose they are is the uploader's to say, and the vault's
    // to learn — their folder says neither.
    const read = await Promise.all(
      [1, 2, 3, 4].map((n) => propose(`Letters/clinic-letter-${n}.pdf`)),
    );
    for (const p of read) {
      expect(p.type_key).toBeUndefined();
      expect(p.owner_member_id).toBeUndefined();
      expect(issuerKey(p.issued_by?.value ?? '')).toBe(issuerKey('Northfield Medical Centre'));
    }
    expect(folderSays('Letters/clinic-letter-1.pdf')).toMatchObject({
      type_key: null,
      owner_member_id: null,
    });
  }, 180_000);
});

/**
 * demo-seed.mjs --corpus (0.8.0, S5): the Smart exit's two hundred papers
 * (scripts/smart-corpus.mjs) written for the vault it has just filled, with
 * everybody they name in the family. A vault of its own: a second run on
 * one adds a second set.
 */
describe.skipIf(!testAdminUrl())('demo-seed.mjs --corpus', () => {
  let h: Harness;
  let port = 0;
  const owner = { email: 'olivia-corpus@example.test', password: `${randomUUID()}-seed` };

  beforeAll(async () => {
    h = await createHarness();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    port = (h.app.server.address() as AddressInfo).port;
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('writes the Smart exit’s 200 papers for the family it names', async () => {
    const corpusOut = await mkdtemp(path.join(tmpdir(), 'fdv-demo-corpus-'));
    try {
      // Without a folder to write them to, it says so before touching the vault.
      const refused = await run(
        process.execPath,
        [SCRIPT, '--url', 'http://127.0.0.1:1', '--corpus'],
        { timeout: 30_000 },
      ).then(
        () => '',
        (e: { stderr: string }) => e.stderr,
      );
      expect(refused).toContain('give one with --out');
      const { stdout } = await run(
        process.execPath,
        [
          SCRIPT,
          '--url',
          `http://127.0.0.1:${port}`,
          '--email',
          owner.email,
          '--password',
          owner.password,
          '--out',
          corpusOut,
          '--corpus',
        ],
        { timeout: 170_000 },
      );
      expect(stdout).toContain('added Maryam, with no sign-in');
      expect(stdout).toContain('added Granny Farida, with no sign-in');
      expect(stdout).toContain("wrote the Smart exit's 200 made-up papers and manifest.json");
      const manifest = JSON.parse(
        await readFile(path.join(corpusOut, 'manifest.json'), 'utf8'),
      ) as { household: { people: Array<{ name: string }> }; files: Array<{ path: string }> };
      expect(manifest.files).toHaveLength(200);
      const written = (await readdir(corpusOut, { recursive: true }))
        .map((n) => String(n).split(path.sep).join('/'))
        .filter((n) => n.endsWith('.pdf'))
        .sort();
      expect(written).toEqual(manifest.files.map((f) => f.path).sort());
      // Everybody the papers name is in the family, as the papers name them.
      const signedIn = (
        await h.app.inject({ method: 'POST', url: '/api/v1/auth/password', payload: owner })
      ).json<Tokens>();
      const family = (
        await h.app.inject({ url: '/api/v1/members', headers: h.as(signedIn) })
      ).json<{ items: Array<{ display_name: string }> }>();
      for (const p of manifest.household.people) {
        expect(family.items.map((m) => m.display_name)).toContain(p.name);
      }
      // And their dates are read as the UK writes them.
      const profile = (
        await h.app.inject({ url: '/api/v1/profile', headers: h.as(signedIn) })
      ).json<{ country: string | null }>();
      expect(profile.country).toBe('GB');
    } finally {
      await rm(corpusOut, { recursive: true, force: true });
    }
  }, 180_000);
});
