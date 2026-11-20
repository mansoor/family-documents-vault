import {
  localToday,
  refusalFor,
  SENSITIVE_SHARE_CONFIRM,
  shareEndWords,
  type FolderDividers,
  type Role,
  type Tokens,
} from '@fdv/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../api.js';
import { createHttp } from '../http.js';
import { multipartBody } from '../multipart.js';
import { contractScenarios, type ContractContext } from './contract.js';
import { createFakeVault } from './fake.js';

/** The contract, against the fake. `apps/api` runs the same against the real API. */
describe('the fake vault keeps the contract', () => {
  const vault = createFakeVault();
  const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
  /** What a person filed of what apps sent, counted: each filing's own Idempotency-Key. */
  let appFilings = 0;
  const ctx: ContractContext = {
    fetch: vault.fetch,
    email: 'owner@example.test',
    password: 'a long enough password',
    // The fake is one household: its type, marked.
    hideType: async (_householdId, key) => {
      const type = vault.state.types.find((t) => t.key === key);
      if (!type) throw new Error(`the fake has no type ${key}`);
      type.hidden = true;
    },
    // Files sent in (0.5.23), as a sender would send them and the worker
    // would get them ready: kept as sent, with one page drawn.
    sendFiles: async (made, files) => {
      for (const f of files) {
        const now = new Date();
        vault.state.incoming.push({
          id: `incoming-${vault.state.incoming.length + 1}`,
          request_id: made.request.id,
          request_title: made.request.title,
          recipient_label: made.request.recipient_label,
          item_label: null,
          name: f.name,
          content_type: f.contentType,
          byte_size: f.bytes.length,
          sender_note: null,
          sent_at: now.toISOString(),
          removed_at: new Date(now.getTime() + 30 * 864e5).toISOString(),
          scan_state: 'unscanned',
          preview_state: 'ready',
          preview_pages: 1,
          suggested_member_id: made.request.suggested_member_id,
          suggested_type_key: made.request.suggested_type_key,
          review_by: made.request.review_by,
          moved_to_owners: false,
          bytes: f.bytes,
        });
      }
    },
    // Somebody else with a sign-in (5.28): in the family, and able to sign in.
    addSignIn: async (_token, who) => {
      const id = `member-${vault.state.members.length + 1}`;
      vault.state.members.push({ id, display_name: who.name, role: who.role, is_me: false });
      vault.state.signIns.push({ member_id: id, email: who.email, password: who.password });
      return id;
    },
    // What a person's filing does to what an app sent (APP3): the fake has
    // no Inbox for it, so a document of theirs with that file is made, and
    // the send filed as it.
    fileAppSend: async (token, app, externalId, file) => {
      const form = multipartBody([
        {
          name: 'metadata',
          value: JSON.stringify({ type_key: 'utility_bill', title: `Filed from ${app.name}` }),
        },
        { name: 'file', filename: 'sent.pdf', contentType: 'application/pdf', bytes: file.bytes },
      ]);
      const made = await api.capture(
        token,
        { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
        // A key of its own each time: a second filing is a new document.
        `d7e8f9a0-1b2c-4d3e-8f4a-${String(++appFilings).padStart(12, '0')}`,
      );
      vault.fileAppIntake(app.id, externalId, made.document_id);
      return made.document_id;
    },
    // An app's file filed into a document that is there, as its newest
    // version (APP6): the fake adds it as one, and files the send so.
    fileAppSendAsVersion: async (token, app, externalId, file, documentId) => {
      const body = multipartBody([
        { name: 'file', filename: 'sent.pdf', contentType: 'application/pdf', bytes: file.bytes },
      ]);
      await api.upload(
        token,
        documentId,
        { kind: 'bytes', bytes: body.bytes, contentType: body.contentType },
        `d7e8f9a0-1b2c-4d3e-8f4a-${String(++appFilings).padStart(12, '0')}`,
      );
      vault.fileAppIntake(app.id, externalId, documentId, true);
    },
    // A connected app's API key past its expiry (APP6): the fake moves its dates.
    expireAppKey: async (clientId) => {
      vault.expireAppKey(clientId);
    },
    // Its access tokens past their end (0.9.0-dev.72): the fake moves their dates.
    expireAppTokens: async () => {
      vault.expireAppTokens();
    },
    // What the pages of an app's file read (APP4): the fake files it, or
    // leaves it waiting, by the vault's own rule.
    readAppSend: async (app, externalId, _file, proposal) => {
      await vault.readAppFile(app.id, externalId, proposal);
    },
    // The fake's owners have two-step sign-in, and have just used it.
    ownerTwoStep: async () => {
      vault.state.ownerTwoStep = true;
    },
    // A guest's sign-in ended a minute ago (5.34).
    endGuestAccess: async (memberId) => {
      const m = vault.state.members.find((x) => x.id === memberId);
      if (m) m.access_expires_at = new Date(Date.now() - 60_000).toISOString();
    },
    // Somebody's 13th birthday, today (after 0.7.0): the owners' reminder,
    // as the worker would make it.
    turnThirteen: async (memberId) => {
      vault.state.personReminders.push({
        id: `person-reminder-${vault.state.personReminders.length + 1}`,
        member_id: memberId,
        fire_at: localToday(vault.state.timezone),
        dismissed: false,
      });
    },
    // A batch's items read, as the worker would read them (I2): kept on each.
    readBatchItems: async (batchId, reads) => {
      const b = vault.state.batches.find((x) => x.id === batchId);
      for (const [id, read] of Object.entries(reads)) {
        const it = b?.items.find((x) => x.id === id);
        if (!it) throw new Error(`the fake has no item ${id}`);
        if ('failure' in read) {
          it.reading = 'failed';
          it.read_failure = read.failure;
        } else {
          it.reading = 'read';
          it.proposal = read.proposal;
          it.paper = read.paper ?? null;
        }
      }
    },
  };
  for (const s of contractScenarios) it(s.name, () => s.run(api, ctx));
});

/**
 * What the contract cannot hold the real vault to with its one owner: a
 * viewer's view of a document's history (0.5.11), as `documents.test.ts`
 * holds the real vault to it.
 */
describe('the fake vault, for somebody who is not an owner', () => {
  const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

  it('a viewer is not told who added each version; everybody else is', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const made = await api.capture(
      tokens.access_token,
      {
        file: { kind: 'bytes', filename: 'lease.pdf', contentType: 'application/pdf', bytes: PDF },
      },
      '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b',
    );
    const who = async () =>
      (await api.versions(tokens.access_token, made.document_id)).items.map(
        (v) => v.uploaded_by_name,
      );
    expect(await who()).toEqual(['Fake Owner']);
    for (const role of ['adult', 'teen'] as const) {
      vault.state.role = role;
      expect(await who()).toEqual(['Fake Owner']);
    }
    vault.state.role = 'viewer';
    expect(await who()).toEqual([null]);
    // A document that is not there has no history to give.
    const refused = await api
      .versions(tokens.access_token, 'no-such-document')
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 404, code: 'not_found' });
  });

  it("a note's stamp as the real vault keeps it (5.35): only a change of words moves it; a viewer is told when, not who, and changes no note; a teen only their own", async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    const made = await api.createDocument(token, { title: 'Bill', notes: 'Paid **monthly**' });
    expect(made.notes_updated_at).toEqual(expect.any(String));
    expect(made.notes_updated_by_name).toBe('Fake Owner');
    const stamp = made.notes_updated_at;
    for (const body of [{ title: 'Water bill' }, { notes: ' Paid **monthly** ' }]) {
      expect((await api.updateDocument(token, made.id, body)).notes_updated_at).toBe(stamp);
    }
    const scan = await api.capture(
      token,
      {
        file: {
          kind: 'bytes',
          filename: 'bill.pdf',
          contentType: 'application/pdf',
          bytes: PDF,
        },
        metadata: { title: 'Scanned', notes: 'Filed with a note' },
      },
      '1c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c',
    );
    expect(await api.document(token, scan.document_id)).toMatchObject({
      notes: 'Filed with a note',
      notes_updated_by_name: 'Fake Owner',
    });

    vault.state.role = 'viewer';
    expect(await api.document(token, made.id)).toMatchObject({
      notes_updated_at: stamp,
      notes_updated_by_name: null,
    });
    expect(
      await refusal(api.updateDocument(token, made.id, { notes: 'Not a viewer’s to change' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });

    vault.state.role = 'teen';
    expect(
      await refusal(api.updateDocument(token, made.id, { notes: 'Not theirs to change' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });
    const own = await api.createDocument(token, {
      title: 'Bus pass',
      owner_member_id: 'fake-member',
    });
    const written = await api.updateDocument(token, own.id, { notes: '- [ ] top up' });
    expect(written).toMatchObject({ notes: '- [ ] top up', notes_updated_by_name: 'Fake Owner' });
    expect((await api.document(token, made.id)).notes).toBe('Paid **monthly**');
  });

  it('what the pages propose, as the real vault answers it (5.37): never a filled field, never to a viewer, a teen for their own', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    expect((await api.capabilities()).features.detail_suggestions).toBe(true);
    const made = await api.createDocument(token, { title: 'Scan' });
    // Nothing given: nothing to read.
    expect(await api.detailSuggestions(token, made.id)).toEqual({
      state: 'unavailable',
      version_id: null,
      proposal: {},
    });
    vault.state.detailSuggestions.set(made.id, {
      state: 'ready',
      version_id: 'v-made',
      proposal: {
        type_key: { value: 'passport', confidence: 0.9, cue: 'kind_words' },
        expires: {
          value: { date: '2031-03-14', precision: 'day' },
          confidence: 0.82,
          cue: 'expiry_label',
        },
        issued: {
          value: { date: '2021-03-14', precision: 'day' },
          confidence: 0.82,
          cue: 'issue_label',
        },
        identifier: { value: '533401872', confidence: 0.85, cue: 'number_label' },
      },
    });
    expect(Object.keys((await api.detailSuggestions(token, made.id)).proposal)).toEqual([
      'type_key',
      'expires',
      'issued',
      'identifier',
    ]);
    // A chip tapped: that field has a value now, and is not offered again.
    await api.updateDocument(token, made.id, {
      expires: { date: '2031-03-14', precision: 'day' },
      issued: { date: '2021-03-14', precision: 'day' },
    });
    expect((await api.document(token, made.id)).issued).toEqual({
      date: '2021-03-14',
      precision: 'day',
    });
    expect(Object.keys((await api.detailSuggestions(token, made.id)).proposal)).toEqual([
      'type_key',
      'identifier',
    ]);
    // Still being read: asked again, nothing yet.
    vault.state.detailSuggestions.set(made.id, {
      state: 'pending',
      version_id: null,
      proposal: {},
    });
    expect((await api.detailSuggestions(token, made.id)).state).toBe('pending');
    expect(await refusal(api.detailSuggestions(token, 'no-such-document'))).toMatchObject({
      status: 404,
    });

    // A viewer — a guest among them — is refused, whatever the id.
    vault.state.role = 'viewer';
    for (const id of [made.id, 'no-such-document']) {
      expect(await refusal(api.detailSuggestions(token, id))).toMatchObject({
        status: 403,
        code: 'forbidden',
        message: refusalFor('document.edit'),
      });
    }
    // A teen, for their own documents only.
    vault.state.role = 'teen';
    expect(await refusal(api.detailSuggestions(token, made.id))).toMatchObject({ status: 403 });
    const own = await api.createDocument(token, {
      title: 'Bus pass',
      owner_member_id: 'fake-member',
    });
    expect((await api.detailSuggestions(token, own.id)).state).toBe('unavailable');
  });

  it('collections as the real vault keeps them for each role (0.5.12): a viewer sees none', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    const everyday = await api.createDocument(token, { title: 'Bill' });
    const adults = await api.createDocument(token, { title: 'Will', visibility: 'adults' });
    const family = await api.createCollection(token, { name: 'Family', audience: 'everyone' });
    await api.addToCollection(token, family.id, [everyday.id, adults.id]);
    const grown = await api.createCollection(token, { name: 'Grown-ups', audience: 'adults' });
    // Made by somebody else, an adult: the fake signs in as one member only.
    vault.state.members.push({ id: 'sam', display_name: 'Sam', role: 'adult', is_me: false });
    for (const l of vault.state.collections) l.owner_member_id = 'sam';

    // A teen is given the collection for everyone, and in it only what a teen may see.
    vault.state.role = 'teen';
    expect((await api.collections(token)).items.map((l) => l.name)).toEqual(['Family']);
    const seen = await api.getCollection(token, family.id);
    expect(seen.items.map((i) => i.document.id)).toEqual([everyday.id]);
    expect(seen.item_count).toBe(1);
    expect(await refusal(api.getCollection(token, grown.id))).toMatchObject({ status: 404 });
    expect(
      await refusal(api.createCollection(token, { name: 'For the adults', audience: 'adults' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });

    // A viewer, none at all, and makes none.
    vault.state.role = 'viewer';
    expect((await api.collections(token)).items).toEqual([]);
    expect(await refusal(api.getCollection(token, family.id))).toMatchObject({ status: 404 });
    expect((await api.documentCollections(token, everyday.id)).items).toEqual([]);
    expect(
      await refusal(api.createCollection(token, { name: 'Mine', audience: 'everyone' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('a maker made a teen keeps their collection to see and delete, not change; an owner deletes one nobody can change (the 5.14 review)', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    const everyday = await api.createDocument(token, { title: 'Bill' });
    const adults = await api.createDocument(token, { title: 'Will', visibility: 'adults' });
    const grown = await api.createCollection(token, { name: 'Grown-ups', audience: 'adults' });
    await api.addToCollection(token, grown.id, [everyday.id, adults.id]);
    const family = await api.createCollection(token, { name: 'Family', audience: 'everyone' });

    // Its maker, made a teen: sees it, with what a teen may see in it.
    vault.state.role = 'teen';
    const seen = await api.getCollection(token, grown.id);
    expect(seen).toMatchObject({ mine: true, item_count: 1 });
    expect(seen.items.map((i) => i.document.id)).toEqual([everyday.id]);
    expect((await api.collections(token)).items.map((l) => l.name)).toEqual([
      'Family',
      'Grown-ups',
    ]);
    // Changes it no more, while the one for everyone is still theirs to change.
    for (const change of [
      api.updateCollection(token, grown.id, { name: 'Taken back' }),
      api.addToCollection(token, grown.id, [everyday.id]),
      api.removeFromCollection(token, grown.id, everyday.id),
    ]) {
      expect(await refusal(change)).toMatchObject({ status: 403, code: 'forbidden' });
    }
    expect(await api.updateCollection(token, family.id, { name: 'Our family' })).toMatchObject({
      name: 'Our family',
    });
    // Made a viewer, deletes it all the same.
    vault.state.role = 'viewer';
    await api.deleteCollection(token, grown.id);
    expect(await refusal(api.getCollection(token, grown.id))).toMatchObject({ status: 404 });

    // An owner deletes a collection whose maker has no sign-in, or is outside its
    // audience; never one whose maker can still change it.
    vault.state.role = 'owner';
    vault.state.members.push({ id: 'kim', display_name: 'Kim', role: 'teen', is_me: false });
    const theirs = async (name: string, maker: string, audience: 'adults' | 'everyone') => {
      const l = await api.createCollection(token, { name, audience });
      const kept = vault.state.collections.find((x) => x.id === l.id);
      if (kept) kept.owner_member_id = maker;
      return l.id;
    };
    const gone = await theirs('Gone', 'nobody-now', 'everyone');
    const outside = await theirs('Outside', 'kim', 'adults');
    const inside = await theirs('Inside', 'kim', 'everyone');
    await api.deleteCollection(token, gone);
    await api.deleteCollection(token, outside);
    expect(await refusal(api.deleteCollection(token, inside))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(await refusal(api.updateCollection(token, outside, { name: 'Mine' }))).toMatchObject({
      status: 404,
    });
  });

  it('collection managers as the real vault keeps them (0.9.0): each power by its switch, given only by who has it', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    expect((await api.capabilities()).features.collection_managers).toBe(true);
    vault.state.members.push(
      { id: 'sam', display_name: 'Sam', role: 'adult', is_me: false },
      { id: 'kim', display_name: 'Kim', role: 'teen', is_me: false },
      { id: 'val', display_name: 'Val', role: 'viewer', is_me: false },
      { id: 'pat', display_name: 'Pat', role: 'adult', is_me: false },
    );
    const bill = await api.createDocument(token, { title: 'Bill' });
    const trip = await api.createCollection(token, { name: 'Trip', audience: 'everyone' });

    // Its maker: every power, and who could manage it — never a viewer.
    expect(trip.my_powers).toEqual({
      maker: true,
      manager: false,
      edit: true,
      change_audience: true,
      delete: true,
      choose_managers: true,
      remove_managers: true,
    });
    const offered = await api.collectionManagers(token, trip.id);
    expect(offered.items).toEqual([]);
    expect(offered.eligible.map((e) => e.member_id)).toEqual(['kim', 'pat', 'sam']);
    // The maker can't be one; a viewer can't either; nobody twice.
    expect(
      await refusal(api.addCollectionManager(token, trip.id, { member_id: 'fake-member' })),
    ).toMatchObject({ status: 422 });
    expect(
      await refusal(api.addCollectionManager(token, trip.id, { member_id: 'val' })),
    ).toMatchObject({ status: 422 });
    await api.addCollectionManager(token, trip.id, { member_id: 'sam', may_choose_managers: true });
    expect(
      await refusal(api.addCollectionManager(token, trip.id, { member_id: 'sam' })),
    ).toMatchObject({ status: 409 });
    const kim = await api.addCollectionManager(token, trip.id, { member_id: 'kim' });
    expect(kim.items.map((m) => [m.display_name, m.may_delete])).toEqual([
      ['Kim', false],
      ['Sam', false],
    ]);

    // Made Sam's, the fake's one person a manager with no switches.
    const kept = vault.state.collections.find((c) => c.id === trip.id);
    if (!kept) throw new Error('no collection');
    kept.owner_member_id = 'sam';
    kept.managers = [
      {
        member_id: 'fake-member',
        may_change_audience: false,
        may_delete: false,
        may_choose_managers: false,
        added_at: new Date().toISOString(),
      },
      ...(kept.managers ?? []).filter((m) => m.member_id !== 'sam'),
    ];
    const seen = await api.getCollection(token, trip.id);
    expect(seen.mine).toBe(false);
    expect(seen.my_powers).toMatchObject({ manager: true, edit: true, delete: false });
    await api.addToCollection(token, trip.id, [bill.id]);
    await api.removeFromCollection(token, trip.id, bill.id);
    await api.updateCollection(token, trip.id, { name: 'Our trip' });
    for (const no of [
      api.updateCollection(token, trip.id, { audience: 'adults' }),
      api.deleteCollection(token, trip.id),
      api.addCollectionManager(token, trip.id, { member_id: 'pat' }),
    ]) {
      expect(await refusal(no)).toMatchObject({ status: 403, code: 'forbidden' });
    }
    // Let choose managers, they give only what they have.
    kept.managers = (kept.managers ?? []).map((m) =>
      m.member_id === 'fake-member' ? { ...m, may_choose_managers: true } : m,
    );
    expect(
      await refusal(
        api.addCollectionManager(token, trip.id, { member_id: 'pat', may_delete: true }),
      ),
    ).toMatchObject({
      status: 403,
      message: 'You can only let a manager do what you can do yourself.',
    });
    await api.addCollectionManager(token, trip.id, { member_id: 'pat', may_choose_managers: true });
    expect(
      await refusal(api.updateCollectionManager(token, trip.id, 'kim', { may_delete: true })),
    ).toMatchObject({ status: 403 });
    // The maker is never taken away.
    expect(await refusal(api.removeCollectionManager(token, trip.id, 'sam'))).toMatchObject({
      status: 422,
    });
    // Let change who it's for: made for the adults, the teen manager goes; never Only me.
    kept.managers = (kept.managers ?? []).map((m) =>
      m.member_id === 'fake-member' ? { ...m, may_change_audience: true } : m,
    );
    expect(
      await refusal(api.updateCollection(token, trip.id, { audience: 'only_me' })),
    ).toMatchObject({ status: 403 });
    // Never leaving its maker outside it: Sam made a teen, the adults' is refused.
    const sam = vault.state.members.find((m) => m.id === 'sam');
    if (!sam) throw new Error('no Sam');
    sam.role = 'teen';
    expect(
      await refusal(api.updateCollection(token, trip.id, { audience: 'adults' })),
    ).toMatchObject({
      status: 422,
      message: 'That would leave Sam unable to see their own collection.',
    });
    sam.role = 'adult';
    const narrowed = await api.updateCollection(token, trip.id, { audience: 'adults' });
    expect(narrowed.managers?.map((m) => m.member_id).sort()).toEqual(['fake-member', 'pat']);
    await api.removeCollectionManager(token, trip.id, 'pat');
    expect((await api.collectionManagers(token, trip.id)).items).toHaveLength(1);

    // Its maker's sign-in gone, a manager left who may not delete it: an owner
    // may delete it, and take its managers away, but not choose any.
    sam.role = null;
    vault.state.role = 'owner';
    vault.state.members.push({ id: 'ann', display_name: 'Ann', role: 'adult', is_me: false });
    kept.managers = [
      {
        member_id: 'ann',
        may_change_audience: false,
        may_delete: false,
        may_choose_managers: false,
        added_at: new Date().toISOString(),
      },
    ];
    expect((await api.getCollection(token, trip.id)).my_powers).toMatchObject({
      delete: true,
      remove_managers: true,
      choose_managers: false,
    });
    expect(
      await refusal(api.addCollectionManager(token, trip.id, { member_id: 'pat' })),
    ).toMatchObject({ status: 403 });
    await api.removeCollectionManager(token, trip.id, 'ann');

    // A viewer is told nothing of managers.
    vault.state.role = 'viewer';
    expect(await refusal(api.collectionManagers(token, trip.id))).toMatchObject({ status: 403 });
  });

  it('removing for good as the real vault does (5.24): somebody else’s is asked about first, a day ahead', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    // Filed by somebody else, though it is the owner's own now: asked about
    // first all the same (the 5.24 review, M524-1).
    const made = await api.createDocument(token, {
      title: 'Their letter',
      owner_member_id: 'fake-member',
    });
    const kept = vault.state.documents.find((d) => d.id === made.id);
    if (kept) kept.filedBySomeoneElse = true;
    await api.deleteDocument(token, made.id);
    const offered = (await api.documents(token, { deleted: 'true' })).items;
    expect(offered.map((d) => [d.id, d.purge_at_once])).toEqual([[made.id, false]]);

    // Asked about, not removed: and from when it may be.
    const asked = await api.purgeDocument(token, made.id);
    expect(asked.removed).toBe(false);
    const document = asked.removed ? null : asked.document;
    expect(document?.filed_by_me).toBe(false);
    expect(Date.parse(document?.purge_allowed_from ?? '')).toBe(
      Date.parse(document?.purge_requested_at ?? '') + 24 * 3_600_000,
    );
    expect(
      (await api.documents(token, { deleted: 'true', purge_requested: 'true' })).items.map(
        (d) => d.id,
      ),
    ).toEqual([made.id]);
    // Again before the day is out: refused, saying from when.
    expect(await refusal(api.purgeDocument(token, made.id))).toMatchObject({
      status: 409,
      code: 'purge_not_yet',
      detail: document?.purge_allowed_from,
    });
    // Brought back, the request goes with it.
    expect((await api.restoreDocument(token, made.id)).purge_requested_at).toBeNull();
    await api.deleteDocument(token, made.id);
    const binned = (await api.documents(token, { deleted: 'true' })).items;
    expect(binned.map((d) => [d.id, d.purge_requested_at])).toEqual([[made.id, null]]);

    // Asked again, and the day over: removed. Never by anybody but an owner.
    await api.purgeDocument(token, made.id);
    if (kept) kept.purge_requested_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
    vault.state.role = 'adult';
    expect(await refusal(api.purgeDocument(token, made.id))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    vault.state.role = 'owner';
    expect(await api.purgeDocument(token, made.id)).toEqual({ removed: true });
    expect((await api.documents(token, { deleted: 'true' })).items).toEqual([]);
  });

  it("pages a collection's documents as the real vault does", async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      ids.push((await api.createDocument(token, { title })).id);
    }
    const collection = await api.createCollection(token, { name: 'Three', audience: 'everyone' });
    await api.addToCollection(token, collection.id, ids);
    const first = await api.getCollection(token, collection.id, { limit: 2 });
    expect(first).toMatchObject({ item_count: 3, has_more: true });
    expect(first.items.map((i) => i.document.id)).toEqual(ids.slice(0, 2));
    const rest = await api.getCollection(token, collection.id, {
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(rest).toMatchObject({ item_count: 3, has_more: false, next_cursor: null });
    expect(rest.items.map((i) => i.document.id)).toEqual(ids.slice(2));
    const bad = await api
      .getCollection(token, collection.id, { cursor: 'nonsense' })
      .catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 422, code: 'validation_failed' });
  });
});

/** Asking to be sent documents (0.5.21), as the real vault answers it. */
describe('the fake vault, people outside the family (5.34)', () => {
  it('refuses as the vault does: an adult re-inviting somebody limited is asked nothing more, but never keeps an owner’s Adults only grant; a guest who never signed in is removed', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    // Somebody of the family with no sign-in yet, limited by an owner.
    vault.state.members.push({ id: 'lena', display_name: 'Lena', role: null, is_me: false });
    const limited = {
      people: ['fake-member'],
      types: [],
      collections: [],
      include_adults_only: false,
      include_no_person_docs: false,
      expires_at: null,
      limits_people: true,
      limits_types: false,
      reconfirm_since: null,
      private_confirmed: false,
      updated_at: new Date().toISOString(),
    };
    vault.state.restrictions.set('lena', limited);
    // An adult (no two-step sign-in): an adult's limits never replace an
    // owner's, so nothing more is asked (the vault's S533-02 is an owner's).
    vault.state.role = 'adult';
    const asked = {
      member_id: 'lena',
      email: 'lena@example.test',
      role: 'viewer' as const,
      restriction: { people: ['fake-member'] },
    };
    const lenaInvite = await api.invite(token, asked);
    expect(lenaInvite.invitation.member_id).toBe('lena');
    // Given Adults only by an owner: an adult's invitation is refused.
    vault.state.restrictions.set('lena', { ...limited, include_adults_only: true });
    expect(
      await refusal(api.invite(token, { ...asked, email: 'lena2@example.test' })),
    ).toMatchObject({ status: 403, code: 'forbidden' });
    // And the adult's made before it, accepted now: refused, and nothing of
    // it kept — she has no sign-in, and an owner may invite her (N534W-02).
    expect(
      await refusal(
        api.acceptInvitationLink(lenaInvite.link_token, {
          code: lenaInvite.code,
          password: 'lena’s own password',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'owner_needed' });
    expect(vault.state.members.find((m) => m.id === 'lena')?.role).toBeNull();
    expect(vault.state.signIns.some((s) => s.member_id === 'lena')).toBe(false);
    // A guest who never signed in: an owner removes them; an adult may not.
    vault.state.role = 'owner';
    vault.state.ownerTwoStep = true;
    const made = await api.invite(token, {
      display_name: 'Rex',
      email: 'rex@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: ['fake-member'] },
      access_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    });
    const rex = made.invitation.member_id;
    vault.state.role = 'adult';
    expect(await refusal(api.removeGuest(token, rex))).toMatchObject({ status: 403 });
    vault.state.role = 'owner';
    await api.removeGuest(token, rex);
    expect((await api.guests(token)).items.map((m) => m.id)).not.toContain(rex);
    expect(await refusal(api.removeGuest(token, 'fake-member'))).toMatchObject({
      status: 409,
      code: 'not_a_guest',
    });
    // A guest who has had a sign-in, since taken away: never invited again
    // as themselves, nor removed (S534-01).
    const gilInvite = {
      display_name: 'Gil',
      email: 'gil@example.test',
      role: 'viewer' as const,
      kind: 'guest' as const,
      restriction: { people: ['fake-member'] },
      access_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    };
    const gilMade = await api.invite(token, gilInvite);
    await api.acceptInvitationLink(gilMade.link_token, {
      code: gilMade.code,
      password: 'gil’s own password',
    });
    const gil = gilMade.invitation.member_id;
    const held = vault.state.members.find((m) => m.id === gil);
    if (held) held.role = null;
    expect(
      await refusal(
        api.invite(token, {
          member_id: gil,
          email: 'gil2@example.test',
          role: 'viewer',
          kind: 'guest',
          restriction: gilInvite.restriction,
          access_expires_at: gilInvite.access_expires_at,
        }),
      ),
    ).toMatchObject({ status: 409, code: 'had_sign_in' });
    expect(await refusal(api.removeGuest(token, gil))).toMatchObject({
      status: 409,
      code: 'had_sign_in',
    });
    // Lena, refused above, is somebody an owner may still invite.
    expect(
      (await api.invite(token, { ...asked, email: 'lena3@example.test' })).invitation.member_id,
    ).toBe('lena');
  });
});

describe('the fake vault, inviting somebody again', () => {
  it('a new invitation for the same person takes back the one still waiting, as the vault does; only its maker or an owner sends it again (N534W-02 b)', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
    vault.state.members.push({ id: 'omar', display_name: 'Omar', role: null, is_me: false });
    const first = await api.invite(token, {
      member_id: 'omar',
      email: 'omar@example.test',
      role: 'teen',
    });
    const second = await api.invite(token, {
      member_id: 'omar',
      email: 'omar.k@example.test',
      role: 'teen',
    });
    // The first link no longer works, and is listed as taken back.
    expect(
      await refusal(
        api.acceptInvitationLink(first.link_token, {
          code: first.code,
          password: 'omar’s own password',
        }),
      ),
    ).toMatchObject({ status: 404, code: 'invitation_not_valid' });
    const states = (await api.invitations(token)).items.map((i) => [i.id, i.state]);
    expect(states).toEqual([
      [first.invitation.id, 'revoked'],
      [second.invitation.id, 'pending'],
    ]);

    // Another adult, who did not make it, may not send it again; an owner may.
    vault.state.members.push({ id: 'sam', display_name: 'Sam', role: 'adult', is_me: false });
    vault.state.signIns.push({
      member_id: 'sam',
      email: 'sam@example.test',
      password: 'sam’s own password',
    });
    const sam = await api.signIn('sam@example.test', 'sam’s own password');
    if (!('access_token' in sam)) throw new Error('Sam could not sign in');
    expect(
      await refusal(
        api.invite(sam.access_token, {
          member_id: 'omar',
          email: 'omar.sam@example.test',
          role: 'teen',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'already_invited' });
    expect(vault.state.invitations.map((i) => i.view.state)).toEqual(['revoked', 'pending']);

    // The one that stands is accepted as ever.
    await api.acceptInvitationLink(second.link_token, {
      code: second.code,
      password: 'omar’s own password',
    });
    expect(vault.state.members.find((m) => m.id === 'omar')?.role).toBe('teen');
  });
});

describe('the fake vault, asking to be sent documents', () => {
  it('an owner asks; a teen is told there is nothing here', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const made = await api.createUploadRequest(tokens.access_token, {
      title: 'Tax papers',
      items: ['W-2'],
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      with_password: true,
    });
    expect(made.password).toBeTruthy();
    expect(made.request).toMatchObject({ state: 'active', protection: ['password'] });
    const listed = await api.uploadRequests(tokens.access_token);
    expect(listed.items.map((r) => r.id)).toEqual([made.request.id]);
    await expect(
      api.createUploadRequest(tokens.access_token, {
        title: 'For ever',
        expires_at: new Date(Date.now() + 91 * 864e5).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 422 });
    await api.revokeUploadRequest(tokens.access_token, made.request.id);
    expect((await api.uploadRequests(tokens.access_token)).items[0]?.state).toBe('revoked');

    vault.state.role = 'teen';
    const teen = await api.signIn('owner@example.test', 'a long enough password');
    if (!('access_token' in teen)) throw new Error('no second step in the fake');
    await expect(api.uploadRequests(teen.access_token)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the fake vault, identity details (5.26)', () => {
  it('a widening whose 72 hours are up reads from then, whichever request asks first (the 5.26 review)', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Teen',
      email: 'teen@example.test',
      password: 'a long enough password',
    });
    vault.state.role = 'teen';
    vault.state.members.push({ id: 'sara', display_name: 'Sara', role: 'adult', is_me: false });
    vault.state.identities.set('sara', {
      shared: {
        fields: { given_name: 'Sara', ids: [{ id: 'p1', kind: 'passport', number: 'P-1' }] },
        version: 1,
        updated_at: new Date().toISOString(),
      },
    });
    // The whole family, from an hour ago; nothing has asked for the audience since.
    vault.state.identityPending = {
      to: 'family',
      requested_at: new Date(Date.now() - 73 * 3_600_000).toISOString(),
      notice_until: new Date(Date.now() - 3_600_000).toISOString(),
    };
    const hers = await api.identity(tokens.access_token, 'sara');
    expect(hers).toMatchObject({
      audience: 'family',
      only_me: null,
      shared: { masked: ['ids.p1'] },
    });
    expect(hers.shared.fields.ids?.[0]).not.toHaveProperty('number');
    // Another person's numbers: a passkey or a code, which this teen has not.
    const refused = await api
      .revealIdentity(tokens.access_token, 'sara', { keys: ['ids.p1'] })
      .then(
        () => null,
        (err: { status?: number; code?: string; message?: string }) => err,
      );
    expect(refused).toMatchObject({
      status: 403,
      code: 'two_step_required',
      message: "Turn on two-step sign-in to see another person's identity numbers.",
    });
  });

  it('a widening is refused while anybody with a sign-in, a teen included, cannot sign in to be told', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const tokens = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    vault.state.members.push({ id: 'tariq', display_name: 'Tariq', role: 'teen', is_me: false });
    vault.state.signInsOff = ['tariq'];
    const refused = await api.setIdentityAudience(tokens.access_token, 'adults').then(
      () => null,
      (err: { status?: number; code?: string; message?: string }) => err,
    );
    expect(refused).toMatchObject({ status: 409, code: 'member_cannot_be_told' });
    expect(refused?.message).toMatch(/^Tariq cannot sign in just now/);
    vault.state.signInsOff = [];
    expect((await api.setIdentityAudience(tokens.access_token, 'adults')).pending?.to).toBe(
      'adults',
    );
  });
});

/**
 * Locking a sign-in, and sign-ins paused after a restore (5.28), as the
 * real vault does them: what the phone's paused screens are tested against.
 */
describe('the fake vault, locked and paused sign-ins (5.28)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string; message?: string; reason?: string }) => err,
    );
  /** A fake vault, its owner signed in with two-step sign-in, and a way to add people who sign in. */
  const start = async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const owner = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    const add = (id: string, name: string, role: Role) => {
      vault.state.members.push({ id, display_name: name, role, is_me: false });
      vault.state.signIns.push({
        member_id: id,
        email: `${id}@example.test`,
        password: `${id}'s own password`,
      });
    };
    const signInAs = async (id: string): Promise<Tokens> => {
      const t = await api.signIn(`${id}@example.test`, `${id}'s own password`);
      if (!('access_token' in t)) throw new Error('no second step in the fake');
      return t;
    };
    return { vault, api, owner, add, signInAs };
  };

  it("ends a locked person's sessions with the reason suspended, and refuses their right password — only once it is right — with 403 membership_suspended; an unlock lets them in again", async () => {
    const { vault, api, owner, add, signInAs } = await start();
    add('sara', 'Sara', 'adult');
    vault.state.memberAccounts.set('sara', {
      member_id: 'sara',
      role: 'adult',
      email: 'sara@example.test',
      two_step: false,
      passkeys: 0,
      last_signed_in_at: null,
      devices: [],
    });
    expect(await api.memberAccount(owner.access_token, 'sara')).toMatchObject({
      suspension: null,
      max_offline_days: 90,
    });
    const hers = await signInAs('sara');
    expect(hers).toMatchObject({ member_id: 'sara', role: 'adult' });
    expect(await api.me(hers.access_token)).toMatchObject({ member_id: 'sara', role: 'adult' });
    // Her session is hers: no owner's view of a sign-in for an adult.
    expect(await refusal(api.memberAccount(hers.access_token, 'sara'))).toMatchObject({
      status: 404,
    });

    // Locked with no end, and a note that is only spaces: none.
    const locked = await api.lockMember(owner.access_token, 'sara', { note: '   ' });
    expect(locked).toEqual({
      member_id: 'sara',
      suspension: {
        reason: 'locked',
        since: expect.any(String) as unknown,
        until: null,
        note: null,
        by: 'Fake Owner',
      },
    });
    expect((await api.memberAccount(owner.access_token, 'sara')).suspension).toEqual(
      locked.suspension,
    );
    // Her session, to its access token and its refresh token alike.
    expect(await refusal(api.me(hers.access_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
    expect(await refusal(api.refresh(hers.refresh_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
    // A wrong password says nothing of the lock.
    const wrong = await refusal(api.signIn('sara@example.test', 'not her password'));
    expect(wrong).toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(wrong?.reason).toBeUndefined();
    expect(await refusal(api.signIn('sara@example.test', "sara's own password"))).toMatchObject({
      status: 403,
      code: 'membership_suspended',
      reason: 'locked',
      message: 'An owner has locked your sign-in. Ask one of them if you need to get in.',
    });
    // Nobody else's session is touched.
    expect(await api.me(owner.access_token)).toMatchObject({ member_id: 'fake-member' });

    await api.unlockMember(owner.access_token, 'sara');
    expect((await api.memberAccount(owner.access_token, 'sara')).suspension).toBeNull();
    expect(await api.me((await signInAs('sara')).access_token)).toMatchObject({
      member_id: 'sara',
    });
    // The session the lock ended stays ended.
    expect(await refusal(api.refresh(hers.refresh_token))).toMatchObject({ reason: 'suspended' });
  });

  it("shows a phone its paused screens: the fake's own person, locked by a test, has their session answer suspended while it lasts, and their sign-in says until when on the household's clock", async () => {
    const { vault, api, owner } = await start();
    vault.state.role = 'adult';
    vault.state.timezone = 'Europe/London';
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    vault.state.suspensions.set('fake-member', {
      reason: 'locked',
      since: new Date().toISOString(),
      until,
      note: null,
      by: 'Mum',
    });
    expect(await refusal(api.me(owner.access_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
    expect(await refusal(api.refresh(owner.refresh_token))).toMatchObject({
      code: 'session_ended',
      reason: 'suspended',
    });
    expect(await refusal(api.signIn('owner@example.test', 'not the password'))).toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    expect(await refusal(api.signIn('owner@example.test', 'a long enough password'))).toMatchObject(
      {
        status: 403,
        code: 'membership_suspended',
        reason: 'locked',
        message: `An owner has locked your sign-in until ${shareEndWords(new Date(until), 'Europe/London')} (Europe/London). Ask one of them if you need to get in sooner.`,
      },
    );
    // No lock ended that session: once the suspension goes, it answers again, as the vault's would.
    vault.state.suspensions.delete('fake-member');
    expect(await api.me(owner.access_token)).toMatchObject({ member_id: 'fake-member' });
  });

  it('takes a lock past its end as over, by the clock: the card says nothing, they sign in, it is not there to unlock, and it may be locked again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.parse('2026-10-05T09:00:00Z');
      vi.setSystemTime(now);
      const { api, owner, add, signInAs } = await start();
      add('sara', 'Sara', 'adult');
      const until = new Date(now + 3_600_000).toISOString();
      await api.lockMember(owner.access_token, 'sara', { until });
      expect((await api.memberAccount(owner.access_token, 'sara')).suspension?.until).toBe(until);
      expect(await refusal(signInAs('sara'))).toMatchObject({ code: 'membership_suspended' });
      // A widening waits while she is locked.
      expect(await refusal(api.setIdentityAudience(owner.access_token, 'adults'))).toMatchObject({
        status: 409,
        code: 'member_cannot_be_told',
      });

      vi.setSystemTime(now + 2 * 3_600_000);
      expect((await api.memberAccount(owner.access_token, 'sara')).suspension).toBeNull();
      expect((await signInAs('sara')).member_id).toBe('sara');
      expect(await refusal(api.unlockMember(owner.access_token, 'sara'))).toMatchObject({
        status: 409,
        code: 'not_locked',
        message: "Sara's sign-in is not locked.",
      });
      // Once she can sign in, a widening is asked for; locking her again withdraws it.
      expect((await api.setIdentityAudience(owner.access_token, 'adults')).pending?.to).toBe(
        'adults',
      );
      const again = await api.lockMember(owner.access_token, 'sara');
      expect(again.suspension).toMatchObject({ reason: 'locked', until: null });
      expect((await api.identityAudience(owner.access_token)).pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses in the real vault's order: who may, what was sent, the owner power, then the person", async () => {
    const { vault, api, owner, add } = await start();
    add('sara', 'Sara', 'adult');
    add('mum', 'Mum', 'owner');
    const token = owner.access_token;

    // Not an owner: refused, whatever was sent.
    vault.state.role = 'adult';
    for (const asked of [
      () => api.lockMember(token, 'sara', { bogus: 1 } as never),
      () => api.unlockMember(token, 'sara'),
    ]) {
      expect(await refusal(asked())).toMatchObject({
        status: 403,
        code: 'forbidden',
        message: refusalFor('member.suspend'),
      });
    }
    expect(await refusal(api.resumeMember(token, 'sara'))).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: refusalFor('restore.review'),
    });

    // An owner without two-step sign-in: what was sent is read first.
    vault.state.role = 'owner';
    vault.state.ownerTwoStep = false;
    for (const body of [
      { bogus: 1 },
      { until: '2026-10-05T07:00' },
      // Without its seconds, as the real vault refuses it (the 5.28 review, R528-5).
      { until: '2026-10-05T23:58Z' },
      { until: '2026-10-05T07:00+09:00' },
      { note: 'x'.repeat(501) },
      { end_links: 'yes' },
    ]) {
      expect(await refusal(api.lockMember(token, 'sara', body as never))).toMatchObject({
        status: 422,
        code: 'validation_failed',
      });
    }
    expect(await refusal(api.lockMember(token, 'sara', { note: 'x'.repeat(501) }))).toMatchObject({
      message: 'A note can be 500 characters at most.',
    });
    for (const asked of [
      () => api.lockMember(token, 'sara'),
      () => api.unlockMember(token, 'sara'),
      () => api.resumeMember(token, 'sara'),
    ]) {
      expect(await refusal(asked())).toMatchObject({
        status: 403,
        code: 'totp_required_for_owner',
        message: "Turn on two-step sign-in to manage other people's sign-ins.",
      });
    }

    // Then the person: nobody; oneself; another owner; locked already.
    vault.state.ownerTwoStep = true;
    for (const asked of [
      () => api.lockMember(token, 'nobody'),
      () => api.unlockMember(token, 'nobody'),
      () => api.resumeMember(token, 'nobody'),
    ]) {
      expect(await refusal(asked())).toMatchObject({
        status: 404,
        code: 'not_found',
        message: 'They have no sign-in to lock.',
      });
    }
    expect(await refusal(api.lockMember(token, 'fake-member'))).toMatchObject({
      status: 422,
      message: 'You cannot lock your own sign-in.',
    });
    expect(await refusal(api.lockMember(token, 'mum'))).toMatchObject({
      status: 409,
      code: 'owner_notice_required',
      message:
        "Mum is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.",
    });
    // An end with its offset, kept as the moment it names.
    const until = new Date(Math.ceil((Date.now() + 10 * 86_400_000) / 60_000) * 60_000);
    const sent = new Date(until.getTime() + 3_600_000).toISOString().replace('Z', '+01:00');
    const locked = await api.lockMember(token, 'sara', { until: sent, end_links: true });
    expect(locked.suspension.until).toBe(until.toISOString());
    expect(await refusal(api.lockMember(token, 'sara', { until: 'nonsense' }))).toMatchObject({
      status: 422,
    });
    expect(await refusal(api.lockMember(token, 'sara'))).toMatchObject({
      status: 409,
      code: 'already_locked',
    });
  });

  it('pauses every sign-in but the owners’ as a restore does, keeps a lock as a lock, and an owner turns each back on', async () => {
    const { vault, api, add, signInAs } = await start();
    add('sara', 'Sara', 'adult');
    add('tariq', 'Tariq', 'teen');
    add('kim', 'Kim', 'viewer');
    add('mum', 'Mum', 'owner');
    const first = await api.signIn('owner@example.test', 'a long enough password');
    if (!('access_token' in first)) throw new Error('no second step in the fake');
    await api.lockMember(first.access_token, 'sara', {
      until: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const teen = await signInAs('tariq');

    vault.pauseSignIns();
    // Every session ends, as a restore ends them.
    for (const t of [first, teen]) {
      expect(await refusal(api.me(t.access_token))).toMatchObject({
        status: 401,
        code: 'session_ended',
        reason: 'revoked',
      });
    }
    const owner = await api.signIn('owner@example.test', 'a long enough password');
    if (!('access_token' in owner)) throw new Error('no second step in the fake');
    const token = owner.access_token;
    // The lock stays a lock, with no end of its own; the others wait for an owner.
    expect((await api.memberAccount(token, 'sara')).suspension).toMatchObject({
      reason: 'locked',
      until: null,
    });
    expect((await api.memberAccount(token, 'tariq')).suspension).toMatchObject({
      reason: 'restored',
      until: null,
      by: null,
    });
    const paused = (await api.afterRestore(token)).sign_ins;
    expect(paused?.map((p) => [p.member_id, p.display_name, p.role])).toEqual([
      ['kim', 'Kim', 'viewer'],
      ['tariq', 'Tariq', 'teen'],
    ]);
    expect(await refusal(signInAs('tariq'))).toMatchObject({
      status: 403,
      code: 'membership_suspended',
      reason: 'restored',
      message:
        'The vault was restored from a backup, and your sign-in waits for an owner to turn it back on. Ask one of them.',
    });
    expect((await signInAs('mum')).role).toBe('owner');
    // Nobody who cannot sign in could be told of a widening.
    expect(await refusal(api.setIdentityAudience(token, 'adults'))).toMatchObject({
      status: 409,
      code: 'member_cannot_be_told',
      message: expect.stringMatching(/^Kim, Sara, Tariq cannot sign in just now/) as unknown,
    });

    // A pause is turned back on, not unlocked; a lock is unlocked, not turned back on.
    expect(await refusal(api.unlockMember(token, 'kim'))).toMatchObject({
      status: 409,
      code: 'not_locked',
    });
    expect(await refusal(api.resumeMember(token, 'sara'))).toMatchObject({
      status: 409,
      code: 'not_paused',
    });
    await api.resumeMember(token, 'kim');
    const viewer = await signInAs('kim');
    // Only an owner is shown them, or turns them back on.
    expect((await api.afterRestore(viewer.access_token)).sign_ins).toEqual([]);
    expect(await refusal(api.resumeMember(viewer.access_token, 'tariq'))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    // Somebody paused may be locked: the lock takes the pause's place.
    expect((await api.lockMember(token, 'tariq')).suspension.reason).toBe('locked');
    expect((await api.afterRestore(token)).sign_ins).toEqual([]);

    // Requests to send documents the restore paused are listed beside them;
    // one paused only by its maker's lock is not the restore's.
    for (const title of ['Paused', 'Locked']) {
      await api.createUploadRequest(token, {
        title,
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      });
    }
    for (const r of vault.state.uploadRequests) {
      Object.assign(r, {
        state: 'paused',
        paused_reason: r.title === 'Paused' ? 'restored' : 'locked',
      });
    }
    expect((await api.afterRestore(token)).upload_requests?.map((r) => r.title)).toEqual([
      'Paused',
    ]);
    expect((await api.afterRestore(viewer.access_token)).upload_requests).toEqual([]);
  });

  it('gives a suspended person no new token, not even for the refresh just replaced (the grace)', async () => {
    const vault = createFakeVault();
    const api = createApi(
      createHttp({
        baseUrl: 'https://fake.example',
        fetch: vault.fetch,
        installationId: '0f5a1c2e-9b7d-4e61-8a33-5c2d7e9f1a40',
      }),
    );
    const first = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    // Rotated, its answer lost on the way: the replay would be let through...
    await api.refresh(first.refresh_token);
    vault.state.role = 'teen';
    vault.state.suspensions.set('fake-member', {
      reason: 'restored',
      since: new Date().toISOString(),
      until: null,
      note: null,
      by: null,
    });
    // ...but not while the sign-in is paused.
    expect(await refusal(api.refresh(first.refresh_token))).toMatchObject({
      status: 401,
      code: 'session_ended',
      reason: 'suspended',
    });
  });

  it("pauses the fake's own person too, when not an owner: the phone's session ends, and its sign-in waits for an owner", async () => {
    const { vault, api, owner } = await start();
    vault.state.role = 'adult';
    vault.pauseSignIns();
    expect(await refusal(api.me(owner.access_token))).toMatchObject({ reason: 'revoked' });
    expect(await refusal(api.signIn('owner@example.test', 'a long enough password'))).toMatchObject(
      { status: 403, code: 'membership_suspended', reason: 'restored' },
    );
    // An owner turned it back on.
    vault.state.suspensions.delete('fake-member');
    const back = await api.signIn('owner@example.test', 'a long enough password');
    expect(back).toMatchObject({ member_id: 'fake-member', role: 'adult' });
  });
});

describe('the fake vault, a password reset an owner starts (5.29)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string; message?: string; reason?: string }) => err,
    );
  const start = async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const owner = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    for (const [id, name, role] of [
      ['sara', 'Sara', 'adult'],
      ['tariq', 'Tariq', 'teen'],
    ] as const) {
      vault.state.members.push({ id, display_name: name, role, is_me: false });
      vault.state.signIns.push({ member_id: id, email: `${id}@example.test`, password: `${id}!` });
    }
    const signInAs = async (id: string): Promise<Tokens> => {
      const t = await api.signIn(`${id}@example.test`, `${id}!`);
      if (!('access_token' in t)) throw new Error('no second step in the fake');
      return t;
    };
    return { vault, api, owner, signInAs };
  };

  it('with no operator mail: a link to hand over for somebody with nothing private, none for anybody else; the card says which beforehand', async () => {
    const { vault, api, owner } = await start();
    vault.state.operatorMail = false;
    vault.state.keepsPrivate = ['tariq'];
    const token = owner.access_token;
    expect((await api.memberAccount(token, 'sara')).reset_path).toBe('handover');
    expect((await api.memberAccount(token, 'tariq')).reset_path).toBe('operator');
    const handed = await api.startPasswordReset(token, 'sara');
    expect(handed).toMatchObject({ member_id: 'sara', path: 'handover', stop_now: false });
    expect(handed.link).toMatch(/\/reset#[A-Za-z0-9_-]{43}$/);
    expect(handed.expires_at).toEqual(expect.any(String));
    const left = await api.startPasswordReset(token, 'tariq');
    expect(left).toEqual({
      member_id: 'tariq',
      path: 'operator',
      stop_now: false,
      command:
        "docker compose exec api node apps/api/dist/cli.mjs reset-password 'tariq@example.test'",
    });
    // No stopping a password where no link can reach them (the 5.29 review).
    const refused = await api.startPasswordReset(token, 'tariq', { stop_now: true }).then(
      () => null,
      (e: { status?: number; code?: string }) => e,
    );
    expect(refused).toMatchObject({ status: 409, code: 'stop_now_unavailable' });
    expect(vault.state.resetsStarted).toEqual([
      { member_id: 'sara', path: 'handover', stop_now: false },
      { member_id: 'tariq', path: 'operator', stop_now: false },
    ]);
  });

  it('the person is told at their next sign-in until they say they saw it; nobody else is', async () => {
    const { vault, api, owner, signInAs } = await start();
    vault.state.operatorMail = false;
    await api.startPasswordReset(owner.access_token, 'sara');
    const sara = await signInAs('sara');
    expect((await api.me(sara.access_token)).reset_notice).toEqual({
      by: 'Fake Owner',
      at: expect.any(String) as unknown,
    });
    expect((await api.me(owner.access_token)).reset_notice).toBeNull();
    await api.dismissResetNotice(sara.access_token);
    expect((await api.me(sara.access_token)).reset_notice).toBeNull();
    // A link by the operator's mail tells nobody at sign-in: the mail is the telling.
    vault.state.operatorMail = true;
    await api.startPasswordReset(owner.access_token, 'sara');
    expect((await api.me(sara.access_token)).reset_notice).toBeNull();
  });

  it("refuses in the real vault's order: who may, what was sent, the owner power, then the person", async () => {
    const { vault, api, owner, signInAs } = await start();
    const sara = await signInAs('sara');
    expect(await refusal(api.startPasswordReset(sara.access_token, 'tariq'))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(
      await refusal(
        api.startPasswordReset(owner.access_token, 'sara', { stop_now: 'yes' } as never),
      ),
    ).toMatchObject({ status: 422, code: 'validation_failed' });
    vault.state.ownerTwoStep = false;
    expect(await refusal(api.startPasswordReset(owner.access_token, 'sara'))).toMatchObject({
      status: 403,
      code: 'totp_required_for_owner',
    });
    vault.state.ownerTwoStep = true;
    expect(await refusal(api.startPasswordReset(owner.access_token, 'nobody'))).toMatchObject({
      status: 404,
    });
    expect(await refusal(api.startPasswordReset(owner.access_token, 'fake-member'))).toMatchObject({
      status: 422,
    });
    vault.state.suspensions.set('sara', {
      reason: 'restored',
      since: new Date().toISOString(),
      until: null,
      note: null,
      by: null,
    });
    expect(await refusal(api.startPasswordReset(owner.access_token, 'sara'))).toMatchObject({
      status: 409,
      code: 'locked',
      message:
        "Sara's sign-in is waiting after a restore. Turn it back on first, then reset their password.",
    });
    expect((await api.memberAccount(owner.access_token, 'sara')).reset_path).toBeNull();
  });
});

describe('the fake vault, the household mailbox set up in Settings (0.9.0, O1)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string; message?: string }) => err,
    );
  it('refuses a port or an address the worker never connects to, and a server changed without the password', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const owner = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const box = (over: Record<string, unknown> = {}) => ({
      host: 'imap.gmail.com',
      port: 993,
      username: 'family@gmail.com',
      password: 'app-password',
      folder: 'INBOX',
      after: 'move' as const,
      authserv_id: null,
      poll_seconds: 300,
      ...over,
    });
    for (const over of [{ port: 143 }, { host: 'localhost' }, { host: '10.0.0.5' }]) {
      expect(
        await refusal(api.setMailInMailbox(owner.access_token, box(over))),
        JSON.stringify(over),
      ).toMatchObject({
        status: 422,
        code: 'mailbox_address_refused',
        message: expect.stringMatching(/port isn’t 993/) as unknown,
      });
    }
    // The ports the worker allows are named.
    vault.state.mailInAllowedPorts = [993, 1143];
    expect(
      await refusal(api.setMailInMailbox(owner.access_token, box({ port: 143 }))),
    ).toMatchObject({
      message: expect.stringMatching(/isn’t one of 993, 1143/) as unknown,
    });
    expect((await api.setMailInMailbox(owner.access_token, box())).mailbox).toMatchObject({
      host: 'imap.gmail.com',
      password: 'set',
    });
    const moved: Record<string, unknown> = box({ host: 'imap.attacker.test' });
    delete moved.password;
    expect(await refusal(api.setMailInMailbox(owner.access_token, moved as never))).toMatchObject({
      status: 422,
      code: 'mailbox_password_needed',
      message: 'Type the app password again for the new server.',
    });
    expect(
      (await api.setMailInMailbox(owner.access_token, box({ host: 'imap.fastmail.com' }))).mailbox,
    ).toMatchObject({ host: 'imap.fastmail.com', password: 'set' });
  });
});

describe('the fake vault, reminders somebody sets themselves (0.9.0-dev.27)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string }) => err,
    );
  it('made on a document, listed, and removed; never one made from its dates, nor on one no longer needed', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const bill = await api.createDocument(token, { title: 'Water bill' });
    const today = new Date().toISOString().slice(0, 10);
    const made = await api.createReminder(token, {
      document_id: bill.id,
      fire_at: today,
      note: 'Check the meter',
    });
    expect(made).toMatchObject({
      document_id: bill.id,
      document_title: 'Water bill',
      kind: 'manual',
      status: 'due',
      note: 'Check the meter',
      label: 'Due today',
    });
    expect((await api.reminders(token, 'due')).items.map((r) => r.id)).toContain(made.id);
    expect(
      await refusal(api.createReminder(token, { document_id: bill.id, fire_at: 'soon' })),
    ).toMatchObject({
      status: 422,
    });
    expect(
      await refusal(api.createReminder(token, { document_id: 'nope', fire_at: today })),
    ).toMatchObject({ status: 404 });

    await api.deleteReminder(token, made.id);
    expect((await api.reminders(token)).items.map((r) => r.id)).not.toContain(made.id);
    expect(await refusal(api.deleteReminder(token, made.id))).toMatchObject({ status: 404 });
    // One made from a document's dates is not removed this way.
    vault.state.reminders.push({ ...made, id: 'derived-1', kind: 'derived' });
    expect(await refusal(api.deleteReminder(token, 'derived-1'))).toMatchObject({ status: 404 });

    await api.markNoLongerNeeded(token, bill.id);
    expect(
      await refusal(api.createReminder(token, { document_id: bill.id, fire_at: today })),
    ).toMatchObject({ status: 409, code: 'no_longer_needed' });
  });
});

describe('the fake vault, mobile numbers (0.9.0, SMS1)', () => {
  it('texts a code to a number, keeps it for the test to read, and confirms the number with it', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token, member_id: me } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect(await api.smsStatus(token)).toEqual({ ready: true });
    const saved = await api.setMemberPhone(token, me, '07700 900123');
    expect(saved.phone).toMatchObject({ masked: '•••• •••123', confirmed: false });
    expect(saved.phone?.code_expires_at).not.toBeNull();
    const sent = vault.state.texts?.at(-1);
    expect(sent?.to).toBe('+447700900123');
    const code = vault.state.phones?.get(me)?.code as string;
    expect(sent?.text).toBe(
      `Family Vault code: ${code}. It confirms this number for Fake. It ends in 10 minutes.`,
    );
    await expect(
      api.confirmMemberPhone(token, me, code === '000000' ? '111111' : '000000'),
    ).rejects.toMatchObject({ status: 422, code: 'phone_code_wrong' });
    const confirmed = await api.confirmMemberPhone(token, me, code);
    expect(confirmed.phone?.confirmed).toBe(true);
    await expect(api.resendMemberPhoneCode(token, me)).rejects.toMatchObject({
      status: 409,
      code: 'phone_confirmed',
    });
    expect((await api.removeMemberPhone(token, me)).phone).toBeNull();
    // Not set up: nothing is offered.
    vault.state.smsReady = false;
    await expect(api.setMemberPhone(token, me, '+447700900123')).rejects.toMatchObject({
      status: 409,
      code: 'sms_not_set_up',
    });
    expect((await api.memberPhone(token, me)).sms_ready).toBe(false);
  });
});

describe('the fake vault, a link shown again to whoever made it (0.9.0)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string }) => err,
    );
  it('shows its maker the link and its PIN again; never anybody else’s, an older one, or one taken back', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.share_reveal).toBe(true);
    const lease = await api.createDocument(token, { title: 'Lease', type_key: 'school_report' });
    const made = await api.share(token, lease.id, { with_pin: true, recipient_label: 'Landlord' });
    expect(made.pin).toMatch(/^\d{4}$/);
    expect(made.share.revealable).toBe(true);
    const listed = (await api.shares(token)).items;
    expect(listed.map((s) => [s.id, s.revealable])).toEqual([[made.share.id, true]]);
    expect(await api.revealShare(token, made.share.id)).toEqual({
      link_token: made.link_token,
      link_url: null,
      pin: made.pin,
    });
    // A password the vault made up, too; one the sharer typed is never kept.
    const pw = await api.share(token, lease.id, { with_password: true });
    expect(await api.revealShare(token, pw.share.id)).toEqual({
      link_token: pw.link_token,
      link_url: null,
      password: pw.password,
    });
    const typed = await api.share(token, lease.id, { password: 'typed by me, at length' });
    expect(await api.revealShare(token, typed.share.id)).toEqual({
      link_token: typed.link_token,
      link_url: null,
    });

    // Somebody else's: there is no such link, for an owner too.
    const theirs = vault.state.shares?.find((l) => l.share.id === typed.share.id);
    vault.state.shares?.push({
      ...(theirs as NonNullable<typeof theirs>),
      share: { ...made.share, id: 'theirs-1' },
      made_by: 'someone-else',
    });
    expect(await refusal(api.revealShare(token, 'theirs-1'))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    // Made before the vault kept copies: shown once.
    vault.state.shares?.push({
      ...(theirs as NonNullable<typeof theirs>),
      share: { ...made.share, id: 'older-1' },
      shown_once: true,
    });
    expect((await api.shares(token)).items.find((s) => s.id === 'older-1')?.revealable).toBe(false);
    expect(await refusal(api.revealShare(token, 'older-1'))).toMatchObject({
      status: 409,
      code: 'share_not_revealable',
    });
    // Taken back: it has ended.
    await api.revokeShare(token, made.share.id);
    expect((await api.shares(token)).items.find((s) => s.id === made.share.id)?.revealable).toBe(
      false,
    );
    expect(await refusal(api.revealShare(token, made.share.id))).toMatchObject({
      status: 410,
      code: 'share_ended',
    });
  });
});

describe('the fake vault, a checklist cleared (0.9.0-dev.39)', () => {
  it('answers a list kept with no lines as none, as the vault does', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const c = await api.createCollection(token, { name: 'Papers', audience: 'everyone' });
    const read = await api.checkChecklist(token, c.id, { text: 'Bank statement' });
    expect((await api.saveChecklist(token, c.id, read.items)).saved_at).not.toBeNull();
    expect((await api.collectionChecklist(token, c.id)).saved_at).not.toBeNull();
    const cleared = await api.saveChecklist(token, c.id, []);
    expect(cleared).toMatchObject({ saved_at: null, items: [] });
    expect(await api.collectionChecklist(token, c.id)).toMatchObject({ saved_at: null, items: [] });
  });
});

describe('the fake vault, a link emailed to its recipient (0.9.0)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string }) => err,
    );
  it('emails its maker’s link three times a day at most, masked after; none without the operator’s mail server', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.share_link_email).toBe(true);
    const lease = await api.createDocument(token, { title: 'Lease', type_key: 'school_report' });
    const made = await api.share(token, lease.id, { with_pin: true });
    expect((await api.shares(token)).items[0]).toMatchObject({
      emailable: true,
      emailed_to: null,
    });
    expect(
      await refusal(api.emailShare(token, made.share.id, { to: 'not an address' })),
    ).toMatchObject({ status: 422 });
    expect(
      await refusal(
        api.emailShare(token, made.share.id, {
          to: 'jane@example.com',
          message: 'See https://elsewhere.example',
        }),
      ),
    ).toMatchObject({ status: 422 });
    for (const left of [2, 1, 0]) {
      const sent = await api.emailShare(token, made.share.id, {
        to: 'jane.smith@example.com',
        message: 'For the flat',
      });
      expect(sent).toMatchObject({ sent_to: 'j•••@e•••.com', sends_left: left });
    }
    expect(
      await refusal(api.emailShare(token, made.share.id, { to: 'jane@example.com' })),
    ).toMatchObject({ status: 429, code: 'email_link_limit' });
    expect((await api.shares(token)).items[0]?.emailed_to).toBe('j•••@e•••.com');

    // Somebody else's: there is no such link.
    const mine = vault.state.shares?.find((l) => l.share.id === made.share.id);
    vault.state.shares?.push({
      ...(mine as NonNullable<typeof mine>),
      share: { ...made.share, id: 'theirs-1' },
      made_by: 'someone-else',
      emailed: [],
    });
    expect(
      await refusal(api.emailShare(token, 'theirs-1', { to: 'jane@example.com' })),
    ).toMatchObject({ status: 404 });
    // Where somebody else's went, and by whom: for whoever sees the link
    // (the owner's decision of 16 Nov 2026).
    vault.state.members.push({ id: 'fake-member-2', display_name: 'Aisha' } as never);
    vault.state.shares?.push({
      ...(mine as NonNullable<typeof mine>),
      share: { ...made.share, id: 'theirs-2' },
      made_by: 'fake-member-2',
      emailed: [{ to: 'aisha.k@example.org', message: null, at: new Date().toISOString() }],
    });
    expect((await api.shares(token)).items.find((s) => s.id === 'theirs-2')).toMatchObject({
      emailed_to: 'a•••@e•••.org',
      emailed_by_name: 'Aisha',
      mine: false,
    });
    // Without the operator's mail server: not offered, and refused.
    vault.state.operatorMail = false;
    expect((await api.capabilities()).features.share_link_email).toBe(false);
    expect((await api.shares(token)).items.find((s) => s.id === made.share.id)?.emailable).toBe(
      false,
    );
    expect(
      await refusal(api.emailShare(token, made.share.id, { to: 'jane@example.com' })),
    ).toMatchObject({ status: 503, code: 'email_link_unavailable' });
  });
});

describe('the fake vault, a link texted to its recipient (0.9.0-dev.69)', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: { status?: number; code?: string }) => err,
    );
  it('texts its maker’s link three times a day at most, masked after; none while texts are not set up', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.link_texts).toBe(true);
    const lease = await api.createDocument(token, { title: 'Lease', type_key: 'school_report' });
    const made = await api.share(token, lease.id, { with_pin: true });
    expect((await api.shares(token)).items[0]).toMatchObject({ textable: true, texted_to: null });
    expect(
      await refusal(api.textShare(token, made.share.id, { to: 'not a number' })),
    ).toMatchObject({ status: 422, code: 'phone_number_invalid' });
    for (const left of [2, 1, 0]) {
      const sent = await api.textShare(token, made.share.id, { to: '07700 900123' });
      expect(sent).toMatchObject({ sent_to: '•••• •••123', sends_left: left });
    }
    expect(
      await refusal(api.textShare(token, made.share.id, { to: '07700 900123' })),
    ).toMatchObject({ status: 429, code: 'text_link_limit' });
    expect((await api.shares(token)).items[0]?.texted_to).toBe('•••• •••123');

    // A request, the same way.
    const ask = await api.createUploadRequest(token, {
      title: 'Tax papers',
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      with_pin: true,
    });
    expect(ask.pin).toMatch(/^\d{4}$/);
    expect(ask.request).toMatchObject({ protection: ['pin'], textable: true });
    expect(
      await api.textUploadRequest(token, ask.request.id, { to: '+44 7700 900456' }),
    ).toMatchObject({ sent_to: '•••• •••456' });
    expect(
      (await api.uploadRequests(token)).items.find((r) => r.id === ask.request.id)?.texted_to,
    ).toBe('•••• •••456');

    // Texts not set up: not offered, and refused.
    vault.state.smsReady = false;
    expect((await api.shares(token)).items[0]?.textable).toBe(false);
    expect(
      await refusal(api.textUploadRequest(token, ask.request.id, { to: '07700 900123' })),
    ).toMatchObject({ status: 409, code: 'sms_not_set_up' });
  });
});

describe('the fake vault, notifications by text (0.9.0, SMS2)', () => {
  it('keeps each person’s texts and quiet hours, off and nine to eight until changed', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.sms_notifications).toBe(true);
    expect(await api.preferences(token)).toEqual({
      daily_push: true,
      daily_email: false,
      weekly_email: true,
      daily_text: false,
      alerts_text: false,
      share_opened_text: false,
      quiet_from: '21:00',
      quiet_to: '08:00',
    });
    expect(
      await api.updatePreferences(token, { daily_text: true, quiet_from: '22:30' }),
    ).toMatchObject({ daily_text: true, alerts_text: false, quiet_from: '22:30' });
    expect(await api.preferences(token)).toMatchObject({ daily_text: true, quiet_from: '22:30' });
    await expect(api.updatePreferences(token, { quiet_to: '8am' })).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('the fake vault, what Sensitive protects (0.9.0, H1a)', () => {
  it('a sensitive document’s link asks first: 409 sensitive_confirm, then made with confirm_sensitive; any other as before', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.sensitive_protects).toBe(true);
    // A passport is sensitive by its kind; so is a paper with no kind.
    const passport = await api.createDocument(token, { title: 'Passport', type_key: 'passport' });
    await expect(api.share(token, passport.id, {})).rejects.toMatchObject({
      status: 409,
      code: 'sensitive_confirm',
      message: SENSITIVE_SHARE_CONFIRM,
    });
    expect(vault.state.shares ?? []).toEqual([]);
    const made = await api.share(token, passport.id, { confirm_sensitive: true });
    expect(made.share.document_id).toBe(passport.id);
    // Its page's title as its maker chose; nothing said, as the document is.
    expect(vault.state.shares?.[0]?.show_title).toBeNull();
    await api.share(token, passport.id, { confirm_sensitive: true, show_title: true });
    expect(vault.state.shares?.[0]?.show_title).toBe(true);
    await expect(
      api.share(token, (await api.createDocument(token, { title: 'Untitled kind' })).id, {}),
    ).rejects.toMatchObject({ status: 409, code: 'sensitive_confirm' });
    // Said not sensitive, or of a kind that is not: as before.
    const mine = await api.createDocument(token, {
      title: 'My passport',
      type_key: 'passport',
      sensitive: false,
    });
    expect((await api.share(token, mine.id, {})).share.document_id).toBe(mine.id);
    const lease = await api.createDocument(token, { title: 'Lease', type_key: 'school_report' });
    expect((await api.share(token, lease.id, {})).share.document_id).toBe(lease.id);

    // Made sensitive while its link still gives it: saved, and said; then ended.
    const edited = await api.updateDocument(token, lease.id, { sensitive: true });
    expect(edited.sensitive_effective).toBe(true);
    expect(edited.warnings).toEqual([{ code: 'sensitive_still_shared', links: 1 }]);
    expect(await api.stopSharing(token, lease.id)).toEqual({ ended: 1, left_out: 0, kept: 0 });
    expect(
      (await api.shares(token)).items.filter((s) => s.document_id === lease.id).map((s) => s.state),
    ).toEqual(['revoked']);
    // Nothing shared any more: an edit says nothing.
    expect(
      (await api.updateDocument(token, lease.id, { title: 'Lease 2' })).warnings,
    ).toBeUndefined();
  });
});

describe('the fake vault, neutral wording (0.9.0, H2)', () => {
  it('keeps the household’s choice for an owner, and each person’s own beside it', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.neutral_wording).toBe(true);
    // Sensitive documents only, and as the household says, until changed.
    expect(await api.neutralWording(token)).toEqual({ neutral_wording: 'sensitive' });
    expect(await api.myWording(token)).toEqual({
      neutral_wording: 'household',
      household: 'sensitive',
      in_effect: ['sensitive'],
    });
    expect(await api.setNeutralWording(token, { neutral_wording: 'health' })).toEqual({
      neutral_wording: 'health',
    });
    // Their own beside the household's: both apply.
    expect(await api.setMyWording(token, { neutral_wording: 'sensitive' })).toEqual({
      neutral_wording: 'sensitive',
      household: 'health',
      in_effect: ['health', 'sensitive'],
    });
    await api.setNeutralWording(token, { neutral_wording: 'all' });
    expect(await api.myWording(token)).toMatchObject({ household: 'all', in_effect: ['all'] });
    await api.setNeutralWording(token, { neutral_wording: 'off' });
    expect(await api.myWording(token)).toMatchObject({ in_effect: ['sensitive'] });
    await expect(
      api.setNeutralWording(token, { neutral_wording: 'loud' as never }),
    ).rejects.toMatchObject({ status: 422 });

    // Anybody but an owner reads their own, and never the household's alone.
    vault.state.role = 'adult';
    await expect(api.neutralWording(token)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(api.setNeutralWording(token, { neutral_wording: 'off' })).rejects.toMatchObject({
      status: 403,
    });
    expect(await api.myWording(token)).toMatchObject({ household: 'off' });
  });
});

describe('the fake vault, codes by text (0.9.0, SMS3)', () => {
  it('a link’s code and an invitation’s by text; a reset’s and a sign-in’s, each the person’s own to ask for', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token, member_id: me } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.sms_codes).toBe(true);

    // A link whose code goes by text: the number only ever masked.
    const lease = await api.createDocument(token, { title: 'Lease', type_key: 'school_report' });
    const made = await api.share(token, lease.id, {
      second_factor: 'sms',
      recipient_phone: '07700 900456',
    });
    expect(made.share).toMatchObject({
      second_factor: 'sms',
      code_to: '•••• •••456',
      protection: ['code'],
    });
    await expect(
      api.share(token, lease.id, { second_factor: 'sms', recipient_phone: 'nope' }),
    ).rejects.toMatchObject({ status: 422, code: 'phone_number_invalid' });

    // An invitation's code, texted as well as shown.
    const invited = await api.invite(token, {
      display_name: 'Sam',
      email: 'sam@example.test',
      role: 'adult',
      invitee_phone: '07700 900777',
    });
    expect(invited.code_texted_to).toBe('•••• •••777');
    expect(vault.state.texts?.at(-1)).toEqual({
      to: '+447700900777',
      text: `Family Vault: Fake invited you to the family vault. Your invitation code is ${invited.code}. Type it on the page your invitation link opens.`,
    });

    // One's own: off until turned on, and only with a confirmed number.
    expect(await api.textCodeSettings(token)).toMatchObject({
      sign_in: false,
      reset: false,
      phone: null,
      can_turn_on: false,
    });
    await expect(api.setTextCodeSettings(token, { reset: true })).rejects.toMatchObject({
      status: 409,
      code: 'sms_code_unavailable',
    });
    await api.setMemberPhone(token, me, '07700 900101');
    await api.confirmMemberPhone(token, me, vault.state.phones?.get(me)?.code as string);
    expect(await api.setTextCodeSettings(token, { reset: true })).toMatchObject({
      reset: true,
      phone: '•••• •••101',
      can_turn_on: true,
      step_up: false,
    });
    // Never an owner's only second step.
    await expect(api.setTextCodeSettings(token, { sign_in: true })).rejects.toMatchObject({
      status: 409,
      code: 'sms_code_needs_factor',
    });
    vault.state.ownerTwoStep = true;
    expect((await api.setTextCodeSettings(token, { sign_in: true })).sign_in).toBe(true);

    // Signing in: the code texted with the password, typed in the one box.
    const challenge = await api.signIn('owner@example.test', 'a long enough password');
    expect(challenge).toMatchObject({
      mfa_required: true,
      methods: ['text'],
      text_to: '•••• •••101',
      text_sent: true,
    });
    const mfaToken = (challenge as { mfa_token: string }).mfa_token;
    const code = vault.state.textCodesOut?.get(`${me}:sign_in`)?.code as string;
    await expect(
      api.signInMfa(mfaToken, code === '000000' ? '111111' : '000000', 'text'),
    ).rejects.toMatchObject({ status: 422, code: 'sms_code_wrong' });
    expect((await api.signInMfa(mfaToken, code, 'text')).access_token).toBeTruthy();
    // An owner never confirms it's them by text; a reset the fake never made is not valid.
    await expect(api.stepUpTextCode(token)).rejects.toMatchObject({
      status: 409,
      code: 'sms_code_not_offered',
    });
    await expect(api.sendResetCode('reset-secret-0123456789abcdef')).rejects.toMatchObject({
      status: 404,
      code: 'reset_not_valid',
    });
  });
});

describe('the fake vault, the AI reader set in Settings (0.9.0, AIR1)', () => {
  it('says it is offered, with the kinds it reads with, and shows an owner the reader saved', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const features = (await api.capabilities()).features;
    expect(features.ai_reader_settings).toBe(true);
    expect(features.ai_reader_kinds).toEqual(['ollama', 'anthropic', 'openai_compatible']);
    expect(features.ai_reader_send_sensitive).toBe(true);
    expect(await api.aiReader(token)).toMatchObject({
      source: 'settings',
      kinds: ['ollama', 'anthropic', 'openai_compatible'],
      env: null,
      reader: null,
      https_only: false,
      send_sensitive: false,
      month: { sent: 0, cap: 500, warned: false },
    });
    vault.state.aiReader = {
      source: 'settings',
      kinds: ['ollama'],
      env: null,
      reader: {
        kind: 'ollama',
        base_url: 'http://192.168.1.30:11434',
        model: 'qwen2.5:3b-instruct',
        timeout_seconds: 120,
        runs_at: 'own_network',
        api_key: 'set',
        api_key_last4: 'WXYZ',
        monthly_cap: 500,
        status: 'ok',
        last_tested_at: '2026-11-12T10:00:00.000Z',
        last_problem: null,
        updated_at: '2026-11-12T09:59:00.000Z',
      },
      https_only: false,
    };
    expect((await api.aiReader(token)).reader).toMatchObject({
      runs_at: 'own_network',
      api_key: 'set',
    });
    vault.state.role = 'adult';
    await expect(api.aiReader(token)).rejects.toMatchObject({ status: 403 });
  });

  it('turns "Also send sensitive papers" on only with a cloud reader, an owner’s alone (AIR3)', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    // No cloud reader: nothing to hold sensitive papers back from.
    await expect(
      api.setAiReaderSendSensitive(token, { send_sensitive: true }),
    ).rejects.toMatchObject({ status: 409, code: 'ai_reader_not_cloud' });
    const view = await api.aiReader(token);
    vault.state.aiReader = {
      ...view,
      reader: {
        kind: 'anthropic',
        base_url: null,
        model: 'claude-haiku-4-5',
        timeout_seconds: 60,
        runs_at: 'cloud',
        api_key: 'set',
        api_key_last4: 'WXYZ',
        monthly_cap: 500,
        status: 'ok',
        last_tested_at: null,
        last_problem: null,
        updated_at: '2026-11-12T09:59:00.000Z',
      },
    };
    expect(
      (await api.setAiReaderSendSensitive(token, { send_sensitive: true })).send_sensitive,
    ).toBe(true);
    expect((await api.aiReader(token)).send_sensitive).toBe(true);
    vault.state.role = 'adult';
    await expect(
      api.setAiReaderSendSensitive(token, { send_sensitive: false }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('the fake vault, my cabinet (0.9.0, C1)', () => {
  it('draws a cabinet from what its person sees, saves it to the version read, and counts each folder as the table does', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.cabinets).toBe(true);
    const year = new Date().getUTCFullYear();
    const issued = (y: number) => ({ date: `${y}-03-01`, precision: 'day' as const });
    vault.state.members.push({ id: 'sam', display_name: 'Sam', role: 'adult', is_me: false });
    const passport = await api.createDocument(token, {
      title: 'Passport',
      type_key: 'passport',
      owner_member_id: 'fake-member',
      issued: issued(year - 1),
    });
    await api.createDocument(token, {
      title: 'Another passport',
      type_key: 'passport',
      owner_member_id: 'fake-member',
      issued: issued(year),
    });
    const secret = await api.createDocument(token, {
      title: 'Sam’s own',
      type_key: 'passport',
      owner_member_id: 'fake-member',
      visibility: 'private',
    });
    // Sam's Only me, as the vault would keep it: never the fake owner's to see.
    const sams = vault.state.documents.find((d) => d.id === secret.id);
    if (sams) sams.owner_member_id = 'sam';

    // None until saved.
    expect(await api.cabinet(token)).toEqual({ layout: null, version: 0, updated_at: null });
    const drawn = await api.previewCabinet(token, 'category_year_person');
    expect(drawn.layout.cabinets.map((c) => [c.name, c.drawers.map((d) => d.name)])).toEqual([
      ['Identity', [String(year), String(year - 1)]],
    ]);
    expect(drawn.layout.cabinets[0]?.drawers[0]?.folders.map((f) => f.name)).toEqual(['Fake']);
    expect(drawn.documents).toBe(2);
    const saved = await api.saveCabinet(token, { layout: drawn.layout, version: 0 });
    expect(saved.version).toBe(1);
    expect((await api.cabinetCounts(token)).counts).toEqual(drawn.counts);
    // A second window, saving to the version it read: refused.
    await expect(
      api.saveCabinet(token, { layout: drawn.layout, version: 0 }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    // Also in: its own year's folder; another's Only me is not there at all.
    const also = await api.documentAlsoIn(token, passport.id);
    expect(also.items.map((i) => i.path)).toEqual([['Identity', String(year - 1), 'Fake']]);
    await expect(api.documentAlsoIn(token, secret.id)).rejects.toMatchObject({ status: 404 });
    // A folder's question is the list's: anything else is refused.
    const folder = (filter: Record<string, unknown>) => ({
      arranged_by: null,
      cabinets: [
        {
          id: 'c',
          name: 'C',
          hidden: false,
          drawers: [
            {
              id: 'd',
              name: 'D',
              hidden: false,
              folders: [{ id: 'f', name: 'F', hidden: false, filter }],
            },
          ],
        },
      ],
    });
    for (const filter of [{ sort: 'title' }, { status: 'lost' }, { issued_from: 'soon' }]) {
      await expect(
        api.saveCabinet(token, { layout: folder(filter), version: 1 }),
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(
      api.saveCabinet(token, {
        layout: folder({ tag: Array.from({ length: 50 }, (_, i) => `${'x'.repeat(90)}${i}`) }),
        version: 1,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('groups a folder behind dividers and keeps pins as the vault does (C2)', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    const caps = (await api.capabilities()).features;
    expect([caps.cabinet_dividers, caps.cabinet_pins]).toEqual([true, true]);
    const make = (title: string, date: string, extra: object = {}) =>
      api.createDocument(token, {
        title,
        type_key: 'school_report',
        owner_member_id: 'fake-member',
        issued: { date, precision: 'day' },
        ...extra,
      });
    await make('Elementary', '2015-03-01');
    await make('Middle', '2021-02-01');
    const nursery = await make('Nursery', '2010-06-01');
    const letter = await api.createDocument(token, { title: 'Letter', type_key: 'passport' });
    const secret = await make('Not mine', '2016-01-01', { visibility: 'private' });
    const theirs = vault.state.documents.find((d) => d.id === secret.id);
    if (theirs) theirs.owner_member_id = 'sam';
    const layout = (dividers?: FolderDividers) => ({
      arranged_by: null,
      cabinets: [
        {
          id: 'c',
          name: 'C',
          hidden: false,
          drawers: [
            {
              id: 'd',
              name: 'D',
              hidden: false,
              folders: [
                {
                  id: 'f',
                  name: 'School',
                  hidden: false,
                  filter: { category: 'education' },
                  ...(dividers ? { dividers } : {}),
                },
                { id: 'g', name: 'Gone', hidden: false, filter: {} },
              ],
            },
          ],
        },
      ],
    });
    let v = (await api.saveCabinet(token, { layout: layout(), version: 0 })).version;
    const years = await api.cabinetFolder(token, 'f');
    expect(years.dividers.map((d) => [d.key, d.count])).toEqual([
      ['year:2021', 1],
      ['year:2015', 1],
      ['year:2010', 1],
    ]);
    expect(years.total).toBe(3);
    const ranges = {
      years: true,
      ranges: [
        { name: 'Elementary', from: '2014-09-01', to: '2020-08-31' },
        { name: 'Middle school', from: '2020-09-01', to: '2023-08-31' },
      ],
    };
    v = (await api.saveCabinet(token, { layout: layout(ranges), version: v })).version;
    const opened = await api.cabinetFolder(token, 'f');
    expect(opened.dividers.map((d) => [d.name, d.count])).toEqual([
      ['Middle school', 1],
      ['Elementary', 1],
      ['Other years', 1],
    ]);
    expect(
      (await api.cabinetFolderDocuments(token, 'f', { divider: 'other' })).items.map((d) => d.id),
    ).toEqual([nursery.id]);
    // Overlapping ranges are refused, as the vault refuses them.
    await expect(
      api.saveCabinet(token, {
        layout: layout({
          years: true,
          ranges: [
            { name: 'A', from: '2014-01-01', to: '2020-12-31' },
            { name: 'B', from: '2020-01-01', to: null },
          ],
        }),
        version: v,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'cabinet_divider_overlap' });
    // A pin: first, counted once, also in; nobody else's Only me.
    await api.pinToFolder(token, 'f', [letter.id]);
    const pinned = await api.cabinetFolder(token, 'f');
    expect(pinned.pinned.map((d) => d.id)).toEqual([letter.id]);
    expect(pinned.total).toBe(4);
    expect((await api.cabinetCounts(token)).counts.f).toBe(4);
    expect((await api.documentAlsoIn(token, letter.id)).items).toContainEqual({
      id: 'f',
      name: 'School',
      path: ['C', 'D', 'School'],
      pinned: true,
    });
    await expect(api.pinToFolder(token, 'f', [secret.id])).rejects.toMatchObject({ status: 404 });
    // Its folder merged away: the pin moves with it; unpinned, it goes.
    const merged = layout(ranges);
    const drawer = merged.cabinets[0]?.drawers[0];
    if (drawer) drawer.folders = drawer.folders.filter((f) => f.id !== 'f');
    await api.saveCabinet(token, {
      layout: merged,
      version: v,
      pins_moved: [{ from: 'f', to: 'g' }],
    });
    expect((await api.cabinetFolder(token, 'g')).pinned.map((d) => d.id)).toEqual([letter.id]);
    expect((await api.cabinetCounts(token)).pins).toEqual({ g: 1 });
    await api.unpinFromFolder(token, 'g', letter.id);
    expect((await api.cabinetFolder(token, 'g')).pinned).toEqual([]);
    // The review's parity (C2): any unpin is 204, another's Only me included.
    await expect(api.unpinFromFolder(token, 'g', secret.id)).resolves.toBeUndefined();
    // A move from a folder the layout keeps copies nothing.
    await api.pinToFolder(token, 'g', [letter.id]);
    const both = layout(ranges);
    const v2 = (await api.cabinet(token)).version;
    await api.saveCabinet(token, {
      layout: both,
      version: v2,
      pins_moved: [{ from: 'g', to: 'f' }],
    });
    expect((await api.cabinetFolder(token, 'f')).pinned).toEqual([]);
    // A hidden folder is not one to pin into.
    const hidden = layout(ranges);
    const g = hidden.cabinets[0]?.drawers[0]?.folders[1];
    if (g) g.hidden = true;
    await api.saveCabinet(token, { layout: hidden, version: v2 + 1 });
    await expect(api.pinToFolder(token, 'g', [nursery.id])).rejects.toMatchObject({ status: 404 });
    // Years outside four figures are refused as they are saved.
    await expect(
      api.saveCabinet(token, {
        layout: layout({ years: true, ranges: [{ name: 'Old', from: '0000-01-01', to: null }] }),
        version: v2 + 2,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'cabinet_divider_dates' });
  });
});

describe('the fake vault, caregivers and turning 18 (0.9.0, H1b)', () => {
  it('names, keeps and revokes a caregiver as the vault does, and asks the turning-18 question once', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.caregivers).toBe(true);
    vault.state.members.push(
      { id: 'sam', display_name: 'Sam', role: 'adult', is_me: false },
      { id: 'tia', display_name: 'Tia', role: 'teen', is_me: false },
      { id: 'omar', display_name: 'Omar', role: null, is_me: false },
    );
    const mine = await api.caregiversOf(token, 'fake-member');
    expect(mine.may_add).toBe(true);
    expect(mine.candidates.map((c) => c.member_id)).toEqual(['sam']);
    // A teen is never a caregiver.
    await expect(api.nameCaregiver(token, 'fake-member', 'tia')).rejects.toMatchObject({
      status: 422,
      code: 'caregiver_not_eligible',
    });
    const g = await api.nameCaregiver(token, 'fake-member', 'sam');
    expect(g).toMatchObject({ caregiver_name: 'Sam', confirmed: true, may_revoke: true });
    expect((await api.myCaregivers(token)).about_me.map((x) => x.caregiver_name)).toEqual(['Sam']);
    // An owner names one for Omar, with no sign-in: unkept, and theirs alone to keep.
    const forOmar = await api.nameCaregiver(token, 'omar', 'sam');
    expect(forOmar.confirmed).toBe(false);
    await expect(api.keepCaregiver(token, 'omar', 'sam')).rejects.toMatchObject({ status: 403 });
    await api.revokeCaregiver(token, 'fake-member', 'sam');
    expect((await api.caregiversOf(token, 'fake-member')).items).toEqual([]);
    expect((await api.caregiverLooks(token, 'fake-member')).items).toEqual([]);
    // Who looked at Sam's papers: the owners' to read too (14 Nov 2026), never which paper.
    vault.state.caregiverLooks = [
      {
        person: 'sam',
        caregiver: 'fake-member',
        document_id: 'd-x',
        action: 'opened',
        at: '2026-11-14T10:00:00Z',
      },
    ];
    expect((await api.caregiverLooks(token, 'sam')).items).toEqual([
      {
        caregiver_name: 'Fake Owner',
        document_id: null,
        title: null,
        sensitive: false,
        only_me: true,
        action: 'opened',
        at: '2026-11-14T10:00:00Z',
      },
    ]);

    // Turning 18: Omar, with no sign-in, asked in person; keep only.
    vault.state.grownUp = [{ member_id: 'omar', turned_on: '2026-11-14', papers: 1, answer: null }];
    const asked = await api.grownUpQuestions(token);
    expect(asked.items).toMatchObject([{ member_id: 'omar', asks: 'in_person' }]);
    await expect(api.answerGrownUp(token, 'omar', 'only_me')).rejects.toMatchObject({
      status: 403,
      code: 'only_the_person',
    });
    expect(await api.answerGrownUp(token, 'omar', 'keep')).toEqual({
      answer: 'keep',
      made_private: 0,
    });
    await expect(api.answerGrownUp(token, 'omar', 'keep')).rejects.toMatchObject({ status: 409 });
    expect((await api.grownUpQuestions(token)).items).toEqual([]);
  });
});

describe('the fake vault, an Idempotency-Key on POST /documents (0.9.0-dev.45)', () => {
  it('answers a repeat with what the first made, as it is now, and refuses another body', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const { access_token: token } = await api.setup({
      household_name: 'The Fake family',
      display_name: 'Fake Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    expect((await api.capabilities()).features.idempotent_create).toBe(true);
    const post = (body: object, key: string) =>
      vault.fetch('https://fake.example/api/v1/documents', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      });
    const body = { type_key: 'note', title: null, notes: 'Behind the bleach' };
    const first = await post(body, 'note-1');
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    const made = (await first.json()) as { id: string };
    await api.updateDocument(token, made.id, { notes: 'Under the sink' });
    // Its keys in another order: the same request, answered as it is now.
    const again = await post(
      { notes: 'Behind the bleach', title: null, type_key: 'note' },
      'note-1',
    );
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.json()).toMatchObject({ id: made.id, notes: 'Under the sink' });
    expect(vault.state.documents.filter((d) => d.id === made.id)).toHaveLength(1);
    const other = await post({ ...body, notes: 'Other words' }, 'note-1');
    expect(other.status).toBe(422);
    expect(await other.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    expect((await post(body, '')).status).toBe(400);
    // Gone: told so, as a replay, and nothing new is made.
    vault.state.documents = vault.state.documents.filter((d) => d.id !== made.id);
    const gone = await post(body, 'note-1');
    expect(gone.status).toBe(404);
    expect(gone.headers.get('idempotent-replayed')).toBe('true');
    expect(await gone.json()).toMatchObject({ error: { code: 'created_not_visible' } });
    expect(vault.state.documents.some((d) => d.notes === 'Behind the bleach')).toBe(false);
    // Kept by household, account, person and key, as the vault's.
    expect([...(vault.state.createKeys?.keys() ?? [])]).toEqual([
      expect.stringMatching(/^fake-household\|account:.*\|fake-member\|note-1$/),
    ]);
    // A day on, by the fake's own clock, the key is no key.
    const start = Date.now();
    vault.state.now = () => start + 24 * 60 * 60 * 1000 + 1;
    expect((await post({ ...body, notes: 'A day later' }, 'note-1')).status).toBe(201);
    // A key is claimed only for a create it makes: a refused one keeps none.
    const before = vault.state.createKeys?.size ?? 0;
    const refused = await post({ type_key: 'no_such_kind', title: 'Refused' }, 'refused-1');
    expect(refused.status).toBe(422);
    expect(vault.state.createKeys?.size ?? 0).toBe(before);
    // Put right, the same key makes it.
    expect((await post({ title: 'Put right' }, 'refused-1')).status).toBe(201);
  });
});
