import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ActivityLine,
  CreatedShare,
  DocumentTypeView,
  DocumentView,
  NotesList,
  SharedNote,
  SharedSession,
  VersionView,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { SearchHit } from './service.js';

/**
 * Notes kept on their own (0.9.0, N1, 0078): a note is a document with no
 * file, of the built-in kind "Note", its words the document's note. So it
 * is kept, sealed, shared and found as every document is — and nothing
 * that files a paper ever gives it a file.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-notes-kept-boundary';

const json = <T>(r: { json: () => unknown }) => r.json() as T;
const codeOf = (r: { json: () => unknown }) =>
  (r.json() as { error?: { code?: string } }).error?.code;

describe.skipIf(!testAdminUrl())('notes kept on their own (0.9.0, N1)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let sarah: Tokens;
  let tariq: Tokens;
  let vera: Tokens;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.91.${Math.floor(++nth / 200)}.${nth % 200}` });

  const get = (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who) });
  const send = (
    who: Tokens,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.as(who), ...headers },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  const note = async (who: Tokens, payload: Record<string, unknown>) => {
    const r = await send(who, 'POST', '/api/v1/documents', {
      type_key: 'note',
      owner_member_id: who.member_id,
      ...payload,
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };
  const notesOf = async (who: Tokens, query = '') => {
    const r = await get(who, `/api/v1/notes${query}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<NotesList>(r);
  };
  const search = async (who: Tokens, q: string) => {
    const r = await get(who, `/api/v1/search?q=${encodeURIComponent(q)}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: SearchHit[]; sealed_pending: { count: number; token?: string } }>(r);
  };
  const upload = (who: Tokens, id: string, file = PDF) => {
    const form = new FormData();
    form.append('file', file, { filename: 'scan.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
  };
  const capture = (who: Tokens, metadata: Record<string, unknown>, file = PDF) => {
    const field = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    );
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([field, head, file, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]),
    });
  };
  /** A link's page: opened, and its session's cookie. */
  const opened = async (token: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token },
      ...peer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'fdv_share')?.value as string;
    return { session: json<SharedSession>(res), cookie };
  };
  const inLink = (cookie: string, url: string) =>
    h.app.inject({ url, cookies: { fdv_share: cookie }, ...peer() });

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    sarah = await h.join(owner, { name: 'Sarah', email: 'sarah-n1@example.test', role: 'adult' });
    tariq = await h.join(owner, { name: 'Tariq', email: 'tariq-n1@example.test', role: 'teen' });
    vera = await h.join(owner, { name: 'Vera', email: 'vera-n1@example.test', role: 'viewer' });
    // Vera, an accountant, is given Sarah's documents only (5.33).
    await h.decider(owner);
    const limited = await send(owner, 'PUT', `/api/v1/members/${vera.member_id}/access`, {
      people: [sarah.member_id],
    });
    expect(limited.statusCode, limited.body).toBe(200);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('a note is a document of the kind Note, with no file, listed with its first words and found within', async () => {
    // No note yet: its kind is not on the list of kinds to file a paper as.
    const before = json<{ items: DocumentTypeView[] }>(await get(owner, '/api/v1/document-types'));
    expect(before.items.map((t) => t.key)).not.toContain('note');
    const all = json<{ items: DocumentTypeView[] }>(
      await get(owner, '/api/v1/document-types?all=true'),
    );
    expect(all.items.map((t) => t.key)).not.toContain('note');

    const boiler = await note(owner, {
      title: 'Boiler',
      visibility: 'household',
      notes: '# Boiler\nRing **Ann** at Northgate Heating first',
      tags: ['house'],
    });
    expect(boiler).toMatchObject({
      type_key: 'note',
      category: 'other',
      versions: 0,
      latest_version_id: null,
      notes: '# Boiler\nRing **Ann** at Northgate Heating first',
      tags: ['house'],
    });
    expect(boiler.notes_updated_at).toEqual(expect.any(String));
    const versions = json<{ items: VersionView[] }>(
      await get(owner, `/api/v1/documents/${boiler.id}/versions`),
    );
    expect(versions.items).toEqual([]);

    // With a note there, an older phone finds its kind by key, as it finds any.
    for (const query of ['', '?all=true']) {
      const after = json<{ items: DocumentTypeView[] }>(
        await get(owner, `/api/v1/document-types${query}`),
      );
      expect(after.items.find((t) => t.key === 'note')).toMatchObject({
        label: 'Note',
        hidden: true,
        builtin: true,
        expiry_driver: null,
      });
    }

    const list = await notesOf(owner);
    expect(list.items.find((n) => n.id === boiler.id)).toMatchObject({
      title: 'Boiler',
      preview: 'Boiler Ring Ann at Northgate Heating first',
      visibility: 'household',
      tags: ['house'],
    });
    expect((await notesOf(owner, '?q=northgate')).items.map((n) => n.id)).toEqual([boiler.id]);
    expect((await notesOf(owner, '?q=BOILER')).items.map((n) => n.id)).toEqual([boiler.id]);
    // A LIKE's own characters are only themselves.
    expect((await notesOf(owner, `?q=${encodeURIComponent('%')}`)).items).toEqual([]);
    // Found by the search, as any document's note is.
    expect((await search(owner, 'Northgate')).items.map((i) => i.document_id)).toContain(boiler.id);
    // Only notes: a document with a note is not one.
    await send(owner, 'POST', '/api/v1/documents', {
      title: 'Boiler warranty',
      type_key: 'warranty',
      notes: 'Northgate too',
    });
    expect((await notesOf(owner, '?q=northgate')).items.map((n) => n.id)).toEqual([boiler.id]);
  });

  it('a note with no title is kept with none, and named by its first words wherever its words are given (the N1 re-check)', async () => {
    const family = await note(owner, {
      visibility: 'household',
      notes: '**Spare key** under the third pot\n\nAsk Sarah first',
    });
    // Nothing of its words copied into a title.
    expect(family.title).toBeNull();
    expect(family.note_name).toBe('Spare key under the third pot');
    const mine = await note(owner, { visibility: 'private', notes: 'Safe: left 4, right 71' });
    expect(mine.title).toBeNull();
    // Its owner's own request opens it, and names it.
    const opened = json<DocumentView>(await get(owner, `/api/v1/documents/${mine.id}`));
    expect(opened.note_name).toBe('Safe: left 4, right 71');
    // A list: the family's named, an Only me one's words never in it.
    const listed = json<{ items: DocumentView[] }>(await get(owner, '/api/v1/documents?limit=200'));
    expect(listed.items.find((d) => d.id === family.id)?.note_name).toBe(
      'Spare key under the third pot',
    );
    const sealedRow = listed.items.find((d) => d.id === mine.id);
    expect(sealedRow).toBeDefined();
    expect(sealedRow?.note_name).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain('right 71');
    // The Documents table, as the family sees it.
    const table = json<{ items: DocumentView[] }>(
      await get(sarah, '/api/v1/documents?sort=recent&limit=200'),
    );
    expect(table.items.find((d) => d.id === family.id)?.note_name).toBe(
      'Spare key under the third pot',
    );
    // A search hit, named the same way.
    const hits = await search(sarah, 'third pot');
    expect(hits.items.find((i) => i.document_id === family.id)).toMatchObject({
      title: null,
      note_name: 'Spare key under the third pot',
    });
    // A note with a title is called by it, and given no other name.
    const titled = await note(owner, { title: 'Boiler code', visibility: 'household', notes: 'x' });
    expect(titled.note_name).toBeUndefined();
  });

  it('words with no-break spaces are found as their words are typed (the N1 re-check)', async () => {
    // Chrome writes a run of typed spaces with no-break ones; and a pasted
    // "Room 101" may have one.
    const family = await note(owner, {
      title: 'Where the meter is',
      visibility: 'household',
      notes: 'Meter in cupboard   under the stairs, Room 101',
    });
    const mine = await note(owner, {
      title: 'Locker',
      visibility: 'private',
      notes: 'Gym locker number 12',
    });
    expect((await notesOf(owner, '?q=under%20the%20stairs')).items.map((n) => n.id)).toEqual([
      family.id,
    ]);
    expect((await notesOf(owner, '?q=cupboard%20under')).items.map((n) => n.id)).toEqual([
      family.id,
    ]);
    expect((await notesOf(owner, '?q=room%20101')).items.map((n) => n.id)).toEqual([family.id]);
    expect((await notesOf(owner, '?q=locker%20number')).items.map((n) => n.id)).toEqual([mine.id]);
    // And by the search, word by word.
    for (const words of ['stairs', 'under the stairs', 'Room 101', 'cupboard under']) {
      expect(
        (await search(owner, words)).items.map((i) => i.document_id),
        words,
      ).toContain(family.id);
    }
  });

  it('a note keeps no file, whatever would file one: a version, a capture, the database itself', async () => {
    const n = await note(owner, { title: 'Spare key', visibility: 'household', notes: 'Pot' });
    const up = await upload(owner, n.id);
    expect([up.statusCode, codeOf(up)]).toEqual([422, 'note_has_no_file']);
    const cap = await capture(owner, { title: 'Scan', type_key: 'note' });
    expect([cap.statusCode, codeOf(cap)]).toEqual([422, 'note_has_no_file']);
    // Refused before a byte is read: a file past the upload limit is told
    // it is a note's, not that it is too big.
    const big = Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024, 0x20)]);
    const bigUp = await upload(owner, n.id, big);
    expect([bigUp.statusCode, codeOf(bigUp)]).toEqual([422, 'note_has_no_file']);
    const bigCap = await capture(owner, { title: 'Scan', type_key: 'note' }, big);
    expect([bigCap.statusCode, codeOf(bigCap)]).toEqual([422, 'note_has_no_file']);
    // And whatever writes, the database holds it (0078).
    await expect(
      admin.query(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         select d.household_id, d.id, 1, 'x.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', 'k',
                (select id from vault where household_id = d.household_id limit 1), '\\x00',
                (select id from scope_key where household_id = d.household_id limit 1)
           from document d where d.id = $1`,
        [n.id],
      ),
    ).rejects.toThrow(/a note keeps no file/);

    // A note stays a note, and no document becomes one.
    const kind = await send(owner, 'PATCH', `/api/v1/documents/${n.id}`, { type_key: 'warranty' });
    expect([kind.statusCode, codeOf(kind)]).toEqual([422, 'note_kind_fixed']);
    const paper = json<DocumentView>(
      await send(owner, 'POST', '/api/v1/documents', { title: 'Bill', type_key: 'utility_bill' }),
    );
    expect((await upload(owner, paper.id)).statusCode).toBe(201);
    const into = await send(owner, 'PATCH', `/api/v1/documents/${paper.id}`, { type_key: 'note' });
    expect([into.statusCode, codeOf(into)]).toEqual([422, 'note_kind_fixed']);
    await expect(
      admin.query(`update document set type_key = 'note' where id = $1`, [paper.id]),
    ).rejects.toThrow(/a document with a file is not a note/);

    // The kind of a note is the vault's.
    await h.decider(owner);
    const shown = await send(owner, 'PATCH', '/api/v1/document-types/note', { hidden: false });
    expect([shown.statusCode, codeOf(shown)]).toEqual([422, 'note_kind_fixed']);
    await expect(
      admin.query(
        `insert into document_type_setting (household_id, type_key, hidden) values ($1, 'note', false)`,
        [owner.household_id],
      ),
    ).rejects.toThrow(/the kind of a note is not changed/);
  });

  it('an Only me note is sealed at rest, and in nobody else’s list, search, counts or preview', async () => {
    const countsBefore = json<unknown>(await get(sarah, '/api/v1/documents/counts'));
    const notesBefore = await notesOf(sarah);
    const safe = await note(owner, {
      title: 'Safe',
      visibility: 'private',
      notes: 'Left 4, right 71, **ostrich**',
    });
    // Sealed: its words are nowhere in the row, nor in the index.
    const row = (
      await admin.query<{ notes: string | null; sealed: boolean; whole: string; tsv: string }>(
        `select notes, notes_sealed is not null as sealed, row_to_json(d)::text as whole,
                search_tsv::text as tsv from document d where id = $1`,
        [safe.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ notes: null, sealed: true });
    expect(row?.whole).not.toMatch(/ostrich/i);
    expect(row?.tsv).not.toMatch(/ostrich/i);

    // Its owner: listed with its words, found within, read whole, and
    // found by the search's private pass.
    expect((await notesOf(owner)).items.find((n) => n.id === safe.id)?.preview).toBe(
      'Left 4, right 71, ostrich',
    );
    expect((await notesOf(owner, '?q=ostrich')).items.map((n) => n.id)).toEqual([safe.id]);
    expect(json<DocumentView>(await get(owner, `/api/v1/documents/${safe.id}`)).notes).toBe(
      'Left 4, right 71, **ostrich**',
    );
    const first = await search(owner, 'ostrich');
    expect(first.items.map((i) => i.document_id)).not.toContain(safe.id);
    const second = await get(
      owner,
      `/api/v1/search/sealed?token=${encodeURIComponent(first.sealed_pending.token as string)}`,
    );
    expect(json<{ items: SearchHit[] }>(second).items.map((i) => i.document_id)).toContain(safe.id);

    // Anybody else: not there at all.
    for (const who of [sarah, tariq, vera]) {
      expect((await notesOf(who)).items.map((n) => n.id)).not.toContain(safe.id);
      expect((await notesOf(who, '?q=ostrich')).items).toEqual([]);
      expect((await get(who, `/api/v1/documents/${safe.id}`)).statusCode).toBe(404);
      expect((await search(who, 'ostrich')).items).toEqual([]);
      expect((await search(who, 'Safe')).items.map((i) => i.document_id)).not.toContain(safe.id);
    }
    expect(json<unknown>(await get(sarah, '/api/v1/documents/counts'))).toEqual(countsBefore);
    expect((await notesOf(sarah)).items).toEqual(notesBefore.items);
  });

  it('one editor at a time: a save from an older copy is refused, with the note as it is now', async () => {
    const n = await note(owner, {
      title: 'Bins',
      visibility: 'household',
      notes: 'Blue on Mondays',
    });
    const mine = await send(
      owner,
      'PATCH',
      `/api/v1/documents/${n.id}`,
      { notes: 'Blue on Tuesdays' },
      {
        'if-match': n.etag,
      },
    );
    expect(mine.statusCode, mine.body).toBe(200);
    const theirs = await send(
      sarah,
      'PATCH',
      `/api/v1/documents/${n.id}`,
      { notes: 'Green' },
      {
        'if-match': n.etag,
      },
    );
    expect([theirs.statusCode, codeOf(theirs)]).toEqual([409, 'conflict']);
    const now = JSON.parse(
      theirs.json<{ error: { detail: string } }>().error.detail,
    ) as DocumentView;
    expect(now.notes).toBe('Blue on Tuesdays');
    expect(json<DocumentView>(await get(owner, `/api/v1/documents/${n.id}`)).notes).toBe(
      'Blue on Tuesdays',
    );
  });

  it('a note’s link gives its words on the page, and only that note', async () => {
    const n = await note(owner, {
      title: 'For the plumber',
      visibility: 'household',
      notes: 'The stopcock is **under the sink**',
    });
    const other = await note(owner, { title: 'Not shared', visibility: 'household', notes: 'No' });
    // To download is refused: there is no file.
    const download = await send(owner, 'POST', `/api/v1/documents/${n.id}/share`, {
      permission: 'download',
    });
    expect([download.statusCode, codeOf(download)]).toEqual([422, 'note_read_on_the_page']);
    const made = await send(owner, 'POST', `/api/v1/documents/${n.id}/share`, {
      recipient_label: 'the plumber',
    });
    expect(made.statusCode, made.body).toBe(201);
    const link = json<CreatedShare>(made);
    expect(link.share).toMatchObject({ permission: 'view', pages: null });
    // Nothing was asked of the worker to draw.
    expect(h.jobs.filter((j) => j.data.share_id === link.share.id)).toEqual([]);

    // The page before Open says it is a note — but behind a PIN, not even
    // that (the N1 review): it waits with the title.
    const preview = (token: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/preview',
        payload: { token },
        ...peer(),
      });
    const open = json<{ note?: boolean; document_title: string | null }>(
      await preview(link.link_token),
    );
    expect(open).toMatchObject({ note: true, document_title: 'For the plumber' });
    const pinned = await send(owner, 'POST', `/api/v1/documents/${n.id}/share`, { with_pin: true });
    expect(pinned.statusCode, pinned.body).toBe(201);
    const withheld = json<{ note?: boolean; document_title: string | null }>(
      await preview(json<CreatedShare>(pinned).link_token),
    );
    expect(withheld.document_title).toBeNull();
    expect(withheld).not.toHaveProperty('note');

    const { session, cookie } = await opened(link.link_token);
    expect(session.items).toEqual([
      expect.objectContaining({ id: n.id, title: 'For the plumber', note: true, pages: null }),
    ]);
    const words = await inLink(cookie, `/api/v1/shared/items/${n.id}/note`);
    expect(words.statusCode, words.body).toBe(200);
    expect(json<SharedNote>(words)).toMatchObject({
      id: n.id,
      title: 'For the plumber',
      body: 'The stopcock is **under the sink**',
    });
    // Looked at once, and said once, however often it is read.
    await inLink(cookie, `/api/v1/shared/items/${n.id}/note`);
    const said = await admin.query<{ action: string }>(
      `select action from audit_event where detail->>'share_id' = $1 order by id`,
      [link.share.id],
    );
    expect(said.rows.map((r) => r.action)).toEqual([
      'share.created',
      'share.opened',
      'share.viewed',
    ]);
    // Said to the family in words, the note named.
    const lines = json<{ items: ActivityLine[] }>(
      await get(owner, '/api/v1/audit?limit=100'),
    ).items;
    expect(lines.filter((l) => l.document_id === n.id).length).toBeGreaterThan(0);
    // Nothing else: no file, no pages, and no other note.
    expect((await inLink(cookie, `/api/v1/shared/items/${n.id}/content`)).statusCode).toBe(404);
    const pages = await inLink(cookie, `/api/v1/shared/items/${n.id}/pages/1`);
    expect([pages.statusCode, codeOf(pages)]).toEqual([404, 'no_preview']);
    const elsewhere = await inLink(cookie, `/api/v1/shared/items/${other.id}/note`);
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.body).not.toContain('No');
    // A document with a file is no note.
    const paper = json<DocumentView>(
      await send(owner, 'POST', '/api/v1/documents', { title: 'Bill', type_key: 'utility_bill' }),
    );
    expect((await inLink(cookie, `/api/v1/shared/items/${paper.id}/note`)).statusCode).toBe(404);
  });

  it('a collection’s link gives its notes, read on the page: those ticked, and those that follow — never another’s Only me (the N1 review)', async () => {
    const paper = json<DocumentView>(
      await send(owner, 'POST', '/api/v1/documents', { title: 'Lease', type_key: 'utility_bill' }),
    );
    expect((await upload(owner, paper.id)).statusCode).toBe(201);
    const n = await note(owner, {
      title: 'Spare keys',
      visibility: 'household',
      notes: 'With the neighbour, dove-91',
    });
    const made = json<{ id: string }>(
      await send(owner, 'POST', '/api/v1/collections', {
        name: 'For the agent',
        audience: 'everyone',
      }),
    );
    const added = await send(owner, 'POST', `/api/v1/collections/${made.id}/items`, {
      document_ids: [paper.id, n.id],
    });
    expect(added.statusCode, added.body).toBe(200);
    // The share sheet offers the note, ticked: it has its words to send.
    await h.decider(owner);
    const sheet = json<{
      items: Array<{ document_id: string; ticked: boolean; lock: string | null }>;
    }>(await get(owner, `/api/v1/collections/${made.id}/share-preview`));
    expect(sheet.items.find((i) => i.document_id === n.id)).toMatchObject({
      ticked: true,
      lock: null,
    });
    const shared = await send(owner, 'POST', `/api/v1/collections/${made.id}/shares`, {
      document_ids: [paper.id, n.id],
      follow_collection: true,
      permission: 'view',
    });
    expect(shared.statusCode, shared.body).toBe(201);
    // Afterwards: another household note follows; Sarah's own Only me one never does.
    const later = await note(owner, {
      title: 'Bins',
      visibility: 'household',
      notes: 'Blue, Mondays',
    });
    // An Only me note put in it never follows.
    const mine = await note(owner, { title: 'Mine', visibility: 'private', notes: 'heron-44' });
    const r = await send(owner, 'POST', `/api/v1/collections/${made.id}/items`, {
      document_ids: [later.id, mine.id],
    });
    expect(r.statusCode, r.body).toBe(200);
    const { session, cookie } = await opened(json<CreatedShare>(shared).link_token);
    expect(session.items.map((i) => i.id)).toEqual([paper.id, n.id, later.id]);
    expect(session.items.find((i) => i.id === n.id)).toMatchObject({ note: true, pages: null });
    const words = await inLink(cookie, `/api/v1/shared/items/${n.id}/note`);
    expect(words.statusCode, words.body).toBe(200);
    expect(json<SharedNote>(words).body).toBe('With the neighbour, dove-91');
    expect((await inLink(cookie, `/api/v1/shared/items/${later.id}/note`)).statusCode).toBe(200);
    const onlyMe = await inLink(cookie, `/api/v1/shared/items/${mine.id}/note`);
    expect(onlyMe.statusCode).toBe(404);
    expect(onlyMe.body).not.toContain('heron-44');
    // Shared by somebody else, another's Only me note never goes, even ticked.
    await h.decider(sarah);
    const hers = await send(sarah, 'POST', `/api/v1/collections/${made.id}/shares`, {
      document_ids: [paper.id, n.id, later.id],
      follow_collection: true,
      permission: 'view',
    });
    expect(hers.statusCode, hers.body).toBe(201);
    const second = await opened(json<CreatedShare>(hers).link_token);
    expect(second.session.items.map((i) => i.id)).toEqual([paper.id, n.id, later.id]);
    const notGiven = await inLink(second.cookie, `/api/v1/shared/items/${mine.id}/note`);
    expect(notGiven.statusCode).toBe(404);
    expect(notGiven.body).not.toContain('heron-44');
    // A note has no file, whatever the link: no content, no pages.
    expect((await inLink(cookie, `/api/v1/shared/items/${n.id}/content`)).statusCode).toBe(404);
  });

  it('a collection’s link to download gives its notes too, as their words', async () => {
    const n = await note(owner, {
      title: 'Alarm',
      visibility: 'household',
      notes: 'Panel by the door',
    });
    const made = json<{ id: string }>(
      await send(owner, 'POST', '/api/v1/collections', {
        name: 'For the sitter',
        audience: 'everyone',
      }),
    );
    await send(owner, 'POST', `/api/v1/collections/${made.id}/items`, { document_ids: [n.id] });
    await h.decider(owner);
    const shared = await send(owner, 'POST', `/api/v1/collections/${made.id}/shares`, {
      document_ids: [n.id],
      permission: 'download',
    });
    expect(shared.statusCode, shared.body).toBe(201);
    const { session, cookie } = await opened(json<CreatedShare>(shared).link_token);
    expect(session.items.map((i) => [i.id, i.note])).toEqual([[n.id, true]]);
    expect(json<SharedNote>(await inLink(cookie, `/api/v1/shared/items/${n.id}/note`)).body).toBe(
      'Panel by the door',
    );
  });

  it('an Only me note’s link opens its words for that link alone', async () => {
    const n = await note(owner, {
      title: 'Lawyer’s number',
      visibility: 'private',
      notes: 'Ask for Jo, pelican-7',
    });
    await h.decider(owner);
    const made = await send(owner, 'POST', `/api/v1/documents/${n.id}/share`, {});
    expect(made.statusCode, made.body).toBe(201);
    const { cookie } = await opened(json<CreatedShare>(made).link_token);
    const words = await inLink(cookie, `/api/v1/shared/items/${n.id}/note`);
    expect(words.statusCode, words.body).toBe(200);
    expect(json<SharedNote>(words).body).toBe('Ask for Jo, pelican-7');
  });

  it('viewers and guests see only what they are given; a teen changes only their own', async () => {
    const hers = await note(sarah, { title: 'Sarah’s', visibility: 'household', notes: 'Hers' });
    const ours = await note(owner, { title: 'Ours', visibility: 'household', notes: 'Ours' });
    const adults = await note(owner, { title: 'Adults', visibility: 'adults', notes: 'Grown-ups' });
    // Vera is given Sarah's documents alone.
    const veras = (await notesOf(vera)).items.map((n) => n.id);
    expect(veras).toContain(hers.id);
    expect(veras).not.toContain(ours.id);
    expect(veras).not.toContain(adults.id);
    expect((await get(vera, `/api/v1/documents/${ours.id}`)).statusCode).toBe(404);
    const veraWrites = await send(vera, 'PATCH', `/api/v1/documents/${hers.id}`, { notes: 'x' });
    expect(veraWrites.statusCode).toBe(403);
    const veraMakes = await send(vera, 'POST', '/api/v1/documents', {
      type_key: 'note',
      title: 'Mine',
    });
    expect(veraMakes.statusCode).toBe(403);
    // A teen reads the family's, not the adults', and changes only their own.
    const tariqs = (await notesOf(tariq)).items.map((n) => n.id);
    expect(tariqs).toContain(ours.id);
    expect(tariqs).not.toContain(adults.id);
    const teenWrites = await send(tariq, 'PATCH', `/api/v1/documents/${ours.id}`, { notes: 'x' });
    expect(teenWrites.statusCode).toBe(403);
    const own = await note(tariq, { title: 'Locker code', notes: '1234' });
    expect(own.owner_member_id).toBe(tariq.member_id);
    expect(
      (await send(tariq, 'PATCH', `/api/v1/documents/${own.id}`, { notes: '4321' })).statusCode,
    ).toBe(200);
  });

  it('a note goes to the Trash, comes back, and is removed for good', async () => {
    const n = await note(owner, { title: 'Old wifi', visibility: 'household', notes: 'hunter2' });
    expect((await send(owner, 'DELETE', `/api/v1/documents/${n.id}`)).statusCode).toBe(204);
    expect((await notesOf(owner)).items.map((x) => x.id)).not.toContain(n.id);
    expect((await notesOf(owner, '?deleted=true')).items.map((x) => x.id)).toContain(n.id);
    expect((await send(owner, 'POST', `/api/v1/documents/${n.id}/restore`)).statusCode).toBe(200);
    expect((await notesOf(owner)).items.map((x) => x.id)).toContain(n.id);
    expect((await send(owner, 'DELETE', `/api/v1/documents/${n.id}`)).statusCode).toBe(204);
    await h.decider(owner);
    const purged = await send(owner, 'POST', `/api/v1/documents/${n.id}/purge`);
    expect(purged.statusCode, purged.body).toBe(204);
    const left = await admin.query('select 1 from document where id = $1', [n.id]);
    expect(left.rowCount).toBe(0);
  });
});
