import { randomUUID } from 'node:crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, NotesList, OfflineSet, SearchResult } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import type { Tokens } from '../auth/service.js';

let peers = 0;
const peer = () => `10.87.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const errorOf = (r: LightMyRequestResponse) =>
  r.json<{ error: { code: string; action?: string; message: string } }>().error;

/**
 * Notes ask "Confirm it's you" as documents do (0.9.0-dev.87). Only an Only
 * me note (`open_private_document`) and an Essential one (`open_essential`)
 * ask, before their words are read (GET /documents/{id}) and before any
 * change to them is saved (PATCH, whose answer gives them), once in five
 * minutes. Sensitive alone never asks. Before it is confirmed, every list —
 * the Notes list, the documents' list, search — gives their title and date
 * alone: no first words, no snippet, never found by a word of theirs. A
 * phone's grant gives an Essential note's words for its offline store.
 */
describe.skipIf(!testAdminUrl())('notes that ask to confirm it is you', () => {
  let h: Harness;
  let owner: Tokens;
  let phone: Tokens;
  const ids: Record<string, string | undefined> = {};

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, t = owner) =>
    h.app.inject({
      method,
      url,
      headers: h.as(t),
      ...(payload ? { payload } : {}),
      remoteAddress: peer(),
    });
  /** Every session of the owner's, made older than the step-up window, or fresh again. */
  const setFresh = (fresh: boolean) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (fresh ? 0 : 6 * 60 * 1000)) })
        .execute(),
    );
  const note = async (title: string, body: object) => {
    const made = await call('POST', '/api/v1/documents', {
      type_key: 'note',
      title,
      owner_member_id: owner.member_id,
      ...body,
    });
    expect(made.statusCode, made.body).toBe(201);
    return made.json<DocumentView>().id;
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 20_000 });
    owner = await h.setup();
    // The owner's phone, for its Essentials.
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { 'x-fdv-installation': randomUUID() },
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
      remoteAddress: peer(),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    phone = signedIn.json<Tokens>();
    ids.essential = await note('Safe', {
      is_essential: true,
      notes: 'The **combination** is behind the kestrel clock',
    });
    ids.mine = await note('Diary', { visibility: 'private', notes: 'Pelican crossing at noon' });
    ids.sensitive = await note('Doctor', { sensitive: true, notes: 'Ask about the walrus rash' });
    ids.plain = await note('Boiler', { notes: 'Ring the heron plumber first' });
    ids.untitledEssential = await note('', { is_essential: true, notes: 'Osprey nest words' });
  }, 120_000);
  afterAll(() => h?.close());

  it('reading an Only me or an Essential note asks, with the action a document asks', async () => {
    await setFresh(false);
    const essential = await call('GET', `/api/v1/documents/${ids.essential}`);
    expect(essential.statusCode).toBe(403);
    expect(errorOf(essential)).toMatchObject({
      code: 'step_up_required',
      action: 'open_essential',
      message: 'Please confirm it is you to open an Essential document.',
    });
    const mine = await call('GET', `/api/v1/documents/${ids.mine}`);
    expect(errorOf(mine)).toMatchObject({
      code: 'step_up_required',
      action: 'open_private_document',
    });
    // Sensitive alone asks nothing, nor does any other note.
    for (const id of [ids.sensitive, ids.plain]) {
      const read = await call('GET', `/api/v1/documents/${id}`);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json<DocumentView>().notes).not.toBeNull();
    }
    // A note that is not there, or not the caller's to see, is a 404 still.
    expect((await call('GET', `/api/v1/documents/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('a save of its words, or any change to it, asks the same; turning Essential off too', async () => {
    await setFresh(false);
    for (const body of [
      { notes: 'Moved behind the owl' },
      { title: 'Safe at home' },
      { tags: ['home'] },
    ]) {
      const saved = await call('PATCH', `/api/v1/documents/${ids.essential}`, body);
      expect(saved.statusCode, JSON.stringify(body)).toBe(403);
      expect(errorOf(saved).action).toBe('open_essential');
    }
    const off = await call('PATCH', `/api/v1/documents/${ids.essential}`, { is_essential: false });
    expect(errorOf(off).action).toBe('open_essential');
    const mine = await call('PATCH', `/api/v1/documents/${ids.mine}`, { notes: 'Gone' });
    expect(errorOf(mine).action).toBe('open_private_document');
    // Nothing was changed.
    await setFresh(true);
    const now = (await call('GET', `/api/v1/documents/${ids.essential}`)).json<DocumentView>();
    expect(now).toMatchObject({ title: 'Safe', is_essential: true, tags: [] });
    expect(now.notes).toContain('kestrel');
  });

  it('within five minutes of confirming, it is read and saved with no second ask', async () => {
    await setFresh(false);
    const step = await call('POST', '/api/v1/auth/step-up', { password: 'correct horse battery' });
    expect(step.statusCode, step.body).toBe(200);
    const read = await call('GET', `/api/v1/documents/${ids.essential}`);
    expect(read.statusCode).toBe(200);
    const doc = read.json<DocumentView>();
    expect(doc.notes).toBe('The **combination** is behind the kestrel clock');
    expect(doc.confirm_to_read).toBeUndefined();
    const saved = await call('PATCH', `/api/v1/documents/${ids.mine}`, {
      notes: 'Pelican crossing at one',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<DocumentView>().notes).toBe('Pelican crossing at one');
  });

  it('the Notes list gives their title and date alone, and never finds one by its words', async () => {
    await setFresh(false);
    const list = (await call('GET', '/api/v1/notes')).json<NotesList>().items;
    const by = (id: string | undefined) => list.find((n) => n.id === id);
    expect(by(ids.essential)).toMatchObject({
      title: 'Safe',
      preview: '',
      is_essential: true,
      confirm_to_read: 'open_essential',
    });
    expect(by(ids.mine)).toMatchObject({ preview: '', confirm_to_read: 'open_private_document' });
    expect(by(ids.untitledEssential)).toMatchObject({ title: null, preview: '' });
    expect(by(ids.sensitive)).toMatchObject({
      preview: 'Ask about the walrus rash',
      sensitive_effective: true,
      confirm_to_read: null,
    });
    expect(by(ids.plain)?.preview).toBe('Ring the heron plumber first');
    const found = async (q: string) =>
      (await call('GET', `/api/v1/notes?q=${encodeURIComponent(q)}`))
        .json<NotesList>()
        .items.map((n) => n.id);
    expect(await found('kestrel')).toEqual([]);
    expect(await found('pelican')).toEqual([]);
    expect(await found('osprey')).toEqual([]);
    expect(await found('heron')).toEqual([ids.plain]);
    // By the title, as ever.
    expect(await found('safe')).toEqual([ids.essential]);
    // Confirmed, still none in a list: a list is a list.
    await setFresh(true);
    expect(await found('kestrel')).toEqual([]);
  });

  it('the documents list and search give no words, no name from them and no snippet', async () => {
    await setFresh(true);
    const listed = (await call('GET', '/api/v1/documents?type_key=note')).json<{
      items: DocumentView[];
    }>().items;
    const essential = listed.find((d) => d.id === ids.essential);
    expect(essential).toMatchObject({
      notes: null,
      has_notes: true,
      confirm_to_read: 'open_essential',
    });
    const untitled = listed.find((d) => d.id === ids.untitledEssential);
    expect(untitled?.note_name).toBeUndefined();
    expect(listed.find((d) => d.id === ids.plain)?.notes).toBe('Ring the heron plumber first');

    const search = async (q: string) =>
      (await call('GET', `/api/v1/search?q=${encodeURIComponent(q)}`)).json<SearchResult>();
    expect((await search('kestrel')).items).toEqual([]);
    expect((await search('osprey')).items).toEqual([]);
    expect((await search('heron')).items.map((i) => i.document_id)).toEqual([ids.plain]);
    // By its title: found, with nothing of its words.
    const safe = (await search('safe')).items.find((i) => i.document_id === ids.essential);
    expect(safe?.snippet).toBe('');
    // The Only me note's words are never opened for the second pass.
    const diary = await search('pelican');
    expect(diary.items).toEqual([]);
    expect(diary.sealed_pending.count).toBe(0);
  });

  it('a change that answers with the note gives its words only within five minutes of confirming', async () => {
    // Put in the Trash and brought back: the answer is the note.
    await setFresh(true);
    expect((await call('GET', `/api/v1/documents/${ids.essential}`)).statusCode).toBe(200);
    const trashed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${ids.untitledEssential}`,
      headers: h.as(owner),
    });
    expect(trashed.statusCode).toBe(204);
    await setFresh(false);
    const back = await call('POST', `/api/v1/documents/${ids.untitledEssential}/restore`);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<DocumentView>()).toMatchObject({
      notes: null,
      confirm_to_read: 'open_essential',
    });
  });

  it('made, or made Essential, the answer gives back the words just written or held', async () => {
    await setFresh(false);
    const made = await call('POST', '/api/v1/documents', {
      type_key: 'note',
      title: 'Spare key',
      owner_member_id: owner.member_id,
      is_essential: true,
      notes: 'Under the puffin pot',
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json<DocumentView>()).toMatchObject({ notes: 'Under the puffin pot' });
    expect(made.json<DocumentView>().confirm_to_read).toBeUndefined();
    const bins = await note('Bins', { notes: 'Blue on Mondays' });
    await setFresh(false);
    const marked = await call('PATCH', `/api/v1/documents/${bins}`, { is_essential: true });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json<DocumentView>().notes).toBe('Blue on Mondays');
    // Read again five minutes on: it asks now.
    expect((await call('GET', `/api/v1/documents/${bins}`)).statusCode).toBe(403);
  });

  it('a change the caller may not make is refused, never asked first', async () => {
    await setFresh(true);
    const vic = await h.join(owner, {
      name: 'Vic',
      email: 'vic-notes@example.test',
      role: 'viewer',
    });
    await setFresh(false);
    const refused = await call(
      'PATCH',
      `/api/v1/documents/${ids.essential}`,
      { title: 'Mine' },
      vic,
    );
    expect([refused.statusCode, errorOf(refused).code]).toEqual([403, 'forbidden']);
    // Reading it asks, as for anybody.
    const read = await call('GET', `/api/v1/documents/${ids.essential}`, undefined, vic);
    expect(errorOf(read).code).toBe('step_up_required');
  });

  it('turned Essential off, it is found by its words again', async () => {
    const hawk = await note('Hawk', { is_essential: true, notes: 'The goshawk ladder' });
    const search = async (q: string) =>
      (await call('GET', `/api/v1/search?q=${encodeURIComponent(q)}`))
        .json<SearchResult>()
        .items.map((i) => i.document_id);
    expect(await search('goshawk')).toEqual([]);
    await setFresh(true);
    const off = await call('PATCH', `/api/v1/documents/${hawk}`, { is_essential: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(await search('goshawk')).toEqual([hawk]);
    const listed = (await call('GET', '/api/v1/notes?q=goshawk')).json<NotesList>().items;
    expect(listed.map((n) => n.id)).toEqual([hawk]);
    expect(listed[0]?.preview).toBe('The goshawk ladder');
  });

  it('a phone keeps Essential notes with their words, an Only me one only when asked', async () => {
    const none = (
      await call('GET', '/api/v1/offline/essentials', undefined, phone)
    ).json<OfflineSet>();
    expect(none.notes).toEqual([]);
    const granted = await call(
      'POST',
      '/api/v1/offline/grant',
      { password: 'correct horse battery' },
      phone,
    );
    expect(granted.statusCode, granted.body).toBe(200);
    const set = (
      await call('GET', '/api/v1/offline/essentials', undefined, phone)
    ).json<OfflineSet>();
    const kept = (set.notes ?? []).map((n) => [n.document.id, n.private, n.document.notes]);
    expect(kept).toContainEqual([
      ids.essential,
      false,
      'The **combination** is behind the kestrel clock',
    ]);
    expect(kept.map((k) => k[0])).not.toContain(ids.plain);
    expect(kept.map((k) => k[0])).not.toContain(ids.mine);
    // Only me, Essential: kept only when the grant includes them, and marked so.
    await setFresh(true);
    expect(
      (await call('PATCH', `/api/v1/documents/${ids.mine}`, { is_essential: true })).statusCode,
    ).toBe(200);
    const also = await call(
      'POST',
      '/api/v1/offline/grant',
      { password: 'correct horse battery', include_private: true },
      phone,
    );
    expect(also.statusCode, also.body).toBe(200);
    const withMine = (
      await call('GET', '/api/v1/offline/essentials', undefined, phone)
    ).json<OfflineSet>();
    expect(withMine.notes?.find((n) => n.document.id === ids.mine)).toMatchObject({
      private: true,
      document: { notes: 'Pelican crossing at one' },
    });
  });
});
