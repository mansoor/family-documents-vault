import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { NOTES_MAX, type ActivityLine, type DocumentView } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { SearchHit } from './service.js';

/**
 * Notes you can write (5.35, A30, A31): one note a document, in a small
 * Markdown, with who last changed its words and when. Changed only by
 * whoever may change the document; read by whoever may see it — a limited
 * viewer or a guest only on what they are given, and never changed by them;
 * sealed for an Only me document, as 5.9 made it; audited without its
 * words; and searched, and shown in a snippet, as plain text.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-notes-capture-boundary';
const DAY = 24 * 60 * 60 * 1000;

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = Awaited<ReturnType<Harness['app']['inject']>>;

interface FirstPass {
  items: SearchHit[];
  sealed_pending: { count: number; token?: string };
}

describe.skipIf(!testAdminUrl())('notes you can write (5.35)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let sarah: Tokens;
  let tariq: Tokens;
  let vera: Tokens;
  let jane: Tokens;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.35.${Math.floor(++nth / 200)}.${nth % 200}` });

  const get = (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who) });
  const send = (who: Tokens, method: 'POST' | 'PATCH' | 'PUT', url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: h.as(who), payload: payload as never });
  const made = async (who: Tokens, payload: Record<string, unknown>) => {
    const r = await send(who, 'POST', '/api/v1/documents', payload);
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };
  const patch = async (who: Tokens, id: string, payload: Record<string, unknown>) => {
    const r = await send(who, 'PATCH', `/api/v1/documents/${id}`, payload);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  const read = async (who: Tokens, id: string) => {
    const r = await get(who, `/api/v1/documents/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  const activity = async (who: Tokens) => {
    const r = await get(who, '/api/v1/audit?limit=100');
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: ActivityLine[] }>(r).items.map((l) => l.text);
  };
  const search = async (who: Tokens, q: string) => {
    const r = await get(who, `/api/v1/search?q=${encodeURIComponent(q)}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<FirstPass>(r);
  };
  /** What the audit log holds for this household, as the owning role reads it. */
  const auditRows = async () =>
    (
      await admin.query<{ action: string; detail: Record<string, unknown> | null; text: string }>(
        `select action, detail, coalesce(detail::text, '') as text
           from audit_event where household_id = $1 order by id`,
        [owner.household_id],
      )
    ).rows;
  const capture = (who: Tokens, metadata: Record<string, unknown>) => {
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
      payload: Buffer.concat([field, head, PDF, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]),
    });
  };

  let sarahBill: DocumentView;
  let ownerBill: DocumentView;
  let will: DocumentView;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    sarah = await h.join(owner, { name: 'Sarah', email: 'sarah-535@example.test', role: 'adult' });
    tariq = await h.join(owner, { name: 'Tariq', email: 'tariq-535@example.test', role: 'teen' });
    vera = await h.join(owner, { name: 'Vera', email: 'vera-535@example.test', role: 'viewer' });
    // Vera, an accountant, is given Sarah's documents only (5.33).
    await h.decider(owner);
    const limited = await send(owner, 'PUT', `/api/v1/members/${vera.member_id}/access`, {
      people: [sarah.member_id],
    });
    expect(limited.statusCode, limited.body).toBe(200);
    // Jane, an attorney from outside the family, is given the same (5.34).
    await h.decider(owner);
    const invited = await send(owner, 'POST', '/api/v1/invitations', {
      display_name: 'Jane Smith',
      relationship: 'attorney',
      email: 'jane-535@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: [sarah.member_id] },
      access_expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'the guest’s own password' },
      ...peer(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    jane = json<Tokens>(accepted);

    sarahBill = await made(owner, {
      title: 'Water bill',
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: sarah.member_id,
      notes: 'Paid by direct debit',
    });
    ownerBill = await made(owner, {
      title: 'Council tax',
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: owner.member_id,
      notes: 'Band D, ostrich reference',
    });
    will = await made(owner, {
      title: 'The will',
      type_key: 'will',
      visibility: 'adults',
      owner_member_id: sarah.member_id,
    });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it("a note's stamp moves only when its words change, and says who changed them", async () => {
    // Written as it was filed: by whoever filed it, then.
    expect(sarahBill.notes_updated_at).toEqual(expect.any(String));
    expect(sarahBill.notes_updated_by_name).toBe('Owner');
    const bare = await made(owner, { title: 'No note yet' });
    expect(bare).toMatchObject({ notes_updated_at: null, notes_updated_by_name: null });

    // Anything else changed, or the same words saved again: it stands.
    const id = sarahBill.id;
    for (const body of [
      { title: 'Water bill, 2026' },
      { notes: 'Paid by direct debit' },
      { notes: '  Paid by direct debit\n' },
      { tags: ['house'] },
    ]) {
      const after = await patch(owner, id, body);
      expect(after.notes_updated_at, JSON.stringify(body)).toBe(sarahBill.notes_updated_at);
      expect(after.notes_updated_by_name, JSON.stringify(body)).toBe('Owner');
    }

    // Sarah changes the words: hers, now.
    const changed = await patch(sarah, id, { notes: 'Paid by **direct debit** on the 1st' });
    expect(changed.notes).toBe('Paid by **direct debit** on the 1st');
    expect(changed.notes_updated_by_name).toBe('Sarah');
    expect(Date.parse(changed.notes_updated_at as string)).toBeGreaterThanOrEqual(
      Date.parse(sarahBill.notes_updated_at as string),
    );
    // Taken off, and written again: each a change.
    const removed = await patch(owner, id, { notes: null });
    expect(removed).toMatchObject({ notes: null, notes_updated_by_name: 'Owner' });
    expect(Date.parse(removed.notes_updated_at as string)).toBeGreaterThanOrEqual(
      Date.parse(changed.notes_updated_at as string),
    );
    const again = await patch(sarah, id, { notes: 'Paid by direct debit' });
    expect(again.notes_updated_by_name).toBe('Sarah');
    // And as a list gives it.
    const listed = await get(sarah, '/api/v1/documents?limit=200');
    expect(json<{ items: DocumentView[] }>(listed).items.find((d) => d.id === id)).toMatchObject({
      notes_updated_at: again.notes_updated_at,
      notes_updated_by_name: 'Sarah',
    });

    // The limit is the limit it always was.
    const long = await send(owner, 'PATCH', `/api/v1/documents/${id}`, {
      notes: 'x'.repeat(NOTES_MAX + 1),
    });
    expect(long.statusCode).toBe(422);
    expect((await patch(owner, id, { notes: 'x'.repeat(NOTES_MAX) })).notes).toHaveLength(
      NOTES_MAX,
    );
    await patch(owner, id, { notes: 'Paid by direct debit' });
  });

  it('the audit has no note text', async () => {
    const WORDS = 'Geranium7731';
    // Written as it is filed, by a capture too; changed; sealed; taken off.
    const doc = await made(owner, { title: 'Spare key', notes: `Under the ${WORDS} pot` });
    const captured = await capture(owner, { title: 'Scanned key', notes: `Behind the ${WORDS}` });
    expect(captured.statusCode, captured.body).toBe(201);
    const scanned = await read(owner, json<{ document_id: string }>(captured).document_id);
    expect(scanned).toMatchObject({ notes: `Behind the ${WORDS}`, notes_updated_by_name: 'Owner' });
    await patch(sarah, doc.id, { notes: `Under the ${WORDS} pot, by the door` });
    const mine = await made(owner, {
      title: 'Mine alone',
      owner_member_id: owner.member_id,
      visibility: 'private',
    });
    await patch(owner, mine.id, { notes: `My ${WORDS}` });
    await patch(owner, doc.id, { notes: null });

    const rows = await auditRows();
    expect(rows.filter((r) => r.text.toLowerCase().includes(WORDS.toLowerCase()))).toEqual([]);
    // Nowhere in the log at all, for any household.
    const anywhere = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_event where coalesce(detail::text, '') ilike $1`,
      [`%${WORDS}%`],
    );
    expect(anywhere.rows[0]?.n).toBe(0);
    // What a change says: which kind it was, and nothing else.
    const changes = rows.filter((r) => r.action === 'document.notes_changed').map((r) => r.detail);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    for (const d of changes) expect(Object.keys(d ?? {})).toEqual(['change']);
    expect(changes.slice(-3)).toEqual([
      { change: 'changed' },
      { change: 'added' },
      { change: 'removed' },
    ]);
    // An edit of the note alone is its own line, not also "edited".
    const updates = rows.filter((r) => r.action === 'document.updated').map((r) => r.detail);
    for (const d of updates)
      expect((d?.fields as string[] | undefined) ?? []).not.toContain('notes');
  });

  it('the activity log says a note changed to whoever may see the document, and nothing of what it says', async () => {
    await patch(owner, will.id, { notes: 'Kept by the solicitor' });
    await patch(owner, sarahBill.id, { notes: 'Paid by direct debit, monthly' });
    const sarahs = await activity(sarah);
    expect(sarahs).toContain('Owner changed the note on “Water bill, 2026”');
    expect(sarahs).toContain('Owner added a note to “The will”');
    const tariqs = await activity(tariq);
    expect(tariqs).toContain('Owner changed the note on “Water bill, 2026”');
    // An Adults only document's line is not a teen's.
    expect(tariqs.filter((l) => l.includes('The will'))).toEqual([]);
    // A viewer reads no log.
    expect((await get(vera, '/api/v1/audit')).statusCode).toBe(403);
  });

  it('a limited viewer or a guest reads a note only on a document they are given, never changes one, and is not told who wrote it', async () => {
    for (const who of [vera, jane]) {
      const given = await read(who, sarahBill.id);
      expect(given.notes).toBe('Paid by direct debit, monthly');
      // When, but not who: a viewer is not told what the family has been doing.
      expect(given.notes_updated_at).toEqual(expect.any(String));
      expect(given.notes_updated_by_name).toBeNull();
      // Not given: not there.
      expect((await get(who, `/api/v1/documents/${ownerBill.id}`)).statusCode).toBe(404);
      const list = json<{ items: DocumentView[] }>(await get(who, '/api/v1/documents?limit=200'));
      expect(list.items.map((d) => d.id)).toContain(sarahBill.id);
      expect(list.items.map((d) => d.id)).not.toContain(ownerBill.id);
      for (const d of list.items) expect(d.notes_updated_by_name ?? null).toBeNull();
      // Nor found by its note's words.
      expect((await search(who, 'ostrich')).items).toEqual([]);
      // And never changed, given or not.
      for (const id of [sarahBill.id, ownerBill.id]) {
        const refused: Res = await send(who, 'PATCH', `/api/v1/documents/${id}`, {
          notes: 'Changed by somebody who may not',
        });
        expect([403, 404]).toContain(refused.statusCode);
      }
    }
    expect((await read(owner, sarahBill.id)).notes).toBe('Paid by direct debit, monthly');
    expect((await read(owner, ownerBill.id)).notes).toBe('Band D, ostrich reference');
  });

  it('a teen changes the note on their own documents, and no one else’s', async () => {
    const theirs = await made(owner, {
      title: 'Bus pass',
      visibility: 'household',
      owner_member_id: tariq.member_id,
    });
    const written = await patch(tariq, theirs.id, { notes: '- [ ] top up' });
    expect(written).toMatchObject({ notes: '- [ ] top up', notes_updated_by_name: 'Tariq' });
    const refused = await send(tariq, 'PATCH', `/api/v1/documents/${sarahBill.id}`, {
      notes: 'Not mine to change',
    });
    expect(refused.statusCode).toBe(403);
  });

  it('an Only me note stays sealed when it is edited, and is found only by its owner, as plain text', async () => {
    const mine = await made(owner, {
      title: 'Safe combination',
      owner_member_id: owner.member_id,
      visibility: 'private',
      notes: 'First words',
    });
    const edited = await patch(owner, mine.id, {
      notes: 'The **Pelican7731** key is under the stairs',
    });
    expect(edited).toMatchObject({
      notes: 'The **Pelican7731** key is under the stairs',
      notes_updated_by_name: 'Owner',
    });
    const { rows } = await admin.query<{
      notes: string | null;
      sealed: boolean;
      terms: string;
      by: string | null;
    }>(
      `select notes, notes_sealed is not null as sealed, search_tsv::text as terms,
              notes_updated_by as by
         from document where id = $1`,
      [mine.id],
    );
    expect(rows[0]).toMatchObject({ notes: null, sealed: true });
    expect(rows[0]?.by).toEqual(expect.any(String));
    expect(rows[0]?.terms.toLowerCase()).not.toContain('pelican7731');
    // Nobody else reaches it.
    expect((await get(sarah, `/api/v1/documents/${mine.id}`)).statusCode).toBe(404);
    // A list keeps it sealed, and says when it changed.
    const listed = json<{ items: DocumentView[] }>(
      await get(owner, '/api/v1/documents?limit=200'),
    ).items.find((d) => d.id === mine.id);
    expect(listed).toMatchObject({
      notes: null,
      has_notes: true,
      notes_updated_at: edited.notes_updated_at,
    });
    // Found by its owner's private pass, with its note as plain text.
    const first = await search(owner, 'Pelican7731');
    expect(first.items.map((i) => i.document_id)).not.toContain(mine.id);
    const second = await get(
      owner,
      `/api/v1/search/sealed?token=${encodeURIComponent(first.sealed_pending.token as string)}`,
    );
    const hit = json<{ items: SearchHit[] }>(second).items.find((i) => i.document_id === mine.id);
    expect(hit?.snippet).toMatch(/Pelican7731/);
    expect(hit?.snippet).not.toContain('**');
    expect((await search(sarah, 'Pelican7731')).items).toEqual([]);
  });

  it("a search's snippet shows a note as plain text", async () => {
    const doc = await made(owner, {
      title: 'Bins',
      notes: '**Blue** bins go out on *Mondays*: see [the rota](https://council.example/rota)',
    });
    const hit = (await search(sarah, 'Mondays')).items.find((i) => i.document_id === doc.id);
    expect(hit?.snippet).toContain('<em>Mondays</em>');
    expect(hit?.snippet).toContain('Blue bins go out');
    expect(hit?.snippet).not.toMatch(/\*|\]\(/);
  });
});
