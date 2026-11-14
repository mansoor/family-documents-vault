import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  SENSITIVE_FOLLOW_CONFIRM,
  SENSITIVE_SHARE_CONFIRM,
  sensitiveCollectionShareConfirm,
  sensitiveResumeConfirm,
  UNTITLED_ON_LINK,
  type ActivityLine,
  type BatchAccepted,
  type BatchDetail,
  type BatchItemView,
  type Capabilities,
  type CreatedShare,
  type DocumentTypeView,
  type DocumentView,
  type SearchHit,
  type SharedSession,
  type ShareLinkPreview,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * What Sensitive protects (0.9.0, H1a of plan-health): the flag of AIR2
 * (`sensitiveOf`: a document's own choice, else its kind's default as the
 * household has it; no kind, sensitive) now also
 *
 *  - starts a teen's own sensitive paper, and a grown-up child's (18+, child,
 *    son or daughter), as Only me where nobody says who can see it — through
 *    POST /documents, a capture and a batch's accept; a parent's paper
 *    about the teen follows the parent's choice;
 *  - asks before it goes outside the family by a link: `409
 *    sensitive_confirm` without `confirm_sensitive: true`, for a document's
 *    link, a collection's with one ticked, and one put in a collection whose
 *    link keeps up with it;
 *  - keeps its words out of search snippets, its title out of the activity
 *    log's lines, and out of a link's page unless the sharer chose
 *    `show_title`;
 *  - and counts nothing anybody who cannot open it would see.
 *
 * Dates are relative to today: a grown-up is twenty years old whenever this
 * runs.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const BOUNDARY = 'fdv-h1a-boundary';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Ids out first: a negative match never trips on hex inside one. */
const noIds = (v: unknown) => JSON.stringify(v).replace(UUID, '<id>');

/** A date of birth on the first of this month, `years + 1` years ago: `years + 1` years old today, whatever today is. */
const bornYearsAgo = (years: number) => {
  const d = new Date();
  return `${d.getUTCFullYear() - years - 1}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

describe.skipIf(!testAdminUrl())('what Sensitive protects (0.9.0, H1a)', () => {
  let h: Harness;
  let owner: Tokens;
  /** Zain, 21, the family's son: an adult. */
  let son: Tokens;
  /** Tia, a teen. */
  let teen: Tokens;
  /** Sara, 46, the children's mum: an adult. */
  let mum: Tokens;
  /** Rafi, an adult with no date of birth, written as a son. */
  let unknownAge: Tokens;
  let admin: ReturnType<typeof createPool>;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const codeOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string } }>(r).error;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    who: Tokens = owner,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.as(who), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const ok = async <T>(r: Promise<LightMyRequestResponse>, status = 200): Promise<T> => {
    const res = await r;
    expect(res.statusCode, res.body).toBe(status);
    return json<T>(res);
  };
  const make = (who: Tokens, payload: Record<string, unknown>) =>
    ok<DocumentView>(call('POST', '/api/v1/documents', payload, who), 201);
  const withFile = async (who: Tokens, doc: DocumentView, name = 'scan.pdf') => {
    const form = new FormData();
    form.append('file', PDF(doc.id), { filename: name, contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
    return doc;
  };
  const capture = (who: Tokens, metadata: Record<string, unknown>) => {
    const part = (name: string, value: string) =>
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    const body = Buffer.concat([
      part('metadata', JSON.stringify(metadata)),
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      PDF(randomUUID()),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: body,
    });
  };
  const visibilityOf = async (who: Tokens, id: string) =>
    (await ok<DocumentView>(call('GET', `/api/v1/documents/${id}`, undefined, who))).visibility;
  /** As if they had just confirmed it's them. */
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  const share = (id: string, body: Record<string, unknown> = {}, who: Tokens = owner) =>
    call('POST', `/api/v1/documents/${id}/share`, body, who);
  const links = async () =>
    Number(
      (
        await admin.query<{ n: string }>(
          'select count(*) as n from share_link where household_id = $1',
          [owner.household_id],
        )
      ).rows[0]?.n,
    );
  const peer = () => ({
    remoteAddress: `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`,
  });
  const preview = (token: string) =>
    ok<ShareLinkPreview>(
      h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/preview',
        payload: { token },
        ...peer(),
      }),
    );
  const unlock = async (token: string) => {
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
  const audit = async (who: Tokens) =>
    (await ok<{ items: ActivityLine[] }>(call('GET', '/api/v1/audit?limit=100', undefined, who)))
      .items;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    son = await h.join(owner, { name: 'Zain', email: 'zain-h1a@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tia', email: 'tia-h1a@example.test', role: 'teen' });
    mum = await h.join(owner, { name: 'Sara', email: 'sara-h1a@example.test', role: 'adult' });
    unknownAge = await h.join(owner, {
      name: 'Rafi',
      email: 'rafi-h1a@example.test',
      role: 'adult',
    });
    admin = createPool(h.adminUrl, 2);
    const set = (t: Tokens, relationship: string | null, dob: string | null) =>
      admin.query('update member set relationship = $1, date_of_birth = $2 where id = $3', [
        relationship,
        dob,
        t.member_id,
      ]);
    await set(son, 'Son', bornYearsAgo(20));
    await set(teen, 'daughter', bornYearsAgo(15));
    await set(mum, 'Mum', bornYearsAgo(45));
    await set(unknownAge, 'son', null);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('says so in its capabilities', async () => {
    const caps = await ok<Capabilities>(call('GET', '/api/v1/capabilities'));
    expect(caps.features.sensitive_protects).toBe(true);
  });

  // ------------------------------------------------------------ who sees it

  describe('who sees a new sensitive paper, nobody having said', () => {
    it('the matrix: uploader’s role, age and relationship × sensitive by its own choice or its kind', async () => {
      // passport: sensitive by its kind, Everyone by default. vehicle
      // registration: not sensitive, Everyone. medical record: sensitive,
      // Adults only.
      const cases: Array<{
        who: Tokens;
        what: string;
        body: Record<string, unknown>;
        want: 'household' | 'adults' | 'private';
      }> = [
        // A teen's own (always their own).
        { who: teen, what: 'teen, passport', body: { type_key: 'passport' }, want: 'private' },
        {
          who: teen,
          what: 'teen, registration',
          body: { type_key: 'vehicle_registration' },
          want: 'household',
        },
        {
          who: teen,
          what: 'teen, registration marked sensitive',
          body: { type_key: 'vehicle_registration', sensitive: true },
          want: 'private',
        },
        { who: teen, what: 'teen, no kind', body: {}, want: 'private' },
        // A grown-up son's own.
        {
          who: son,
          what: 'son, own passport',
          body: { type_key: 'passport', owner_member_id: 'self' },
          want: 'private',
        },
        {
          who: son,
          what: 'son, own registration',
          body: { type_key: 'vehicle_registration', owner_member_id: 'self' },
          want: 'household',
        },
        {
          who: son,
          what: 'son, own registration marked sensitive',
          body: { type_key: 'vehicle_registration', owner_member_id: 'self', sensitive: true },
          want: 'private',
        },
        {
          who: son,
          what: 'son, own passport marked not sensitive',
          body: { type_key: 'passport', owner_member_id: 'self', sensitive: false },
          want: 'household',
        },
        {
          who: son,
          what: 'son, own medical record',
          body: { type_key: 'medical_record', owner_member_id: 'self' },
          want: 'private',
        },
        // Not his own: as before.
        {
          who: son,
          what: 'son, his mum’s passport',
          body: { type_key: 'passport', owner_member_id: 'mum' },
          want: 'household',
        },
        {
          who: son,
          what: 'son, nobody’s passport',
          body: { type_key: 'passport' },
          want: 'household',
        },
        // Asked for: as asked.
        {
          who: son,
          what: 'son, own passport for everyone, asked',
          body: { type_key: 'passport', owner_member_id: 'self', visibility: 'household' },
          want: 'household',
        },
        // A parent: their own, and theirs about the teen, as before.
        {
          who: mum,
          what: 'mum, own passport',
          body: { type_key: 'passport', owner_member_id: 'self' },
          want: 'household',
        },
        {
          who: mum,
          what: 'mum, the teen’s passport',
          body: { type_key: 'passport', owner_member_id: 'teen' },
          want: 'household',
        },
        {
          who: mum,
          what: 'mum, the teen’s medical record',
          body: { type_key: 'medical_record', owner_member_id: 'teen' },
          want: 'adults',
        },
        // An owner with no relationship, and a "son" whose age nobody knows.
        {
          who: owner,
          what: 'owner, own passport',
          body: { type_key: 'passport', owner_member_id: 'self' },
          want: 'household',
        },
        {
          who: unknownAge,
          what: 'son of no known age, an adult, own passport',
          body: { type_key: 'passport', owner_member_id: 'self' },
          // Signing in as an adult, and a son: grown (the review, M3).
          want: 'private',
        },
      ];
      const ids: Record<string, string> = { mum: mum.member_id, teen: teen.member_id };
      const got: string[] = [];
      const want: string[] = [];
      for (const c of cases) {
        const body: Record<string, unknown> = { title: `M ${c.what}`, ...c.body };
        if (body.owner_member_id === 'self') body.owner_member_id = c.who.member_id;
        else if (typeof body.owner_member_id === 'string')
          body.owner_member_id = ids[body.owner_member_id];
        const res = await call('POST', '/api/v1/documents', body, c.who);
        expect(res.statusCode, `${c.what}: ${res.body}`).toBe(201);
        got.push(`${c.what}: ${json<DocumentView>(res).visibility}`);
        want.push(`${c.what}: ${c.want}`);
      }
      expect(got).toEqual(want);
    });

    it('a kind made sensitive by the household counts as its own choice would', async () => {
      await admin.query(
        `insert into document_type_setting (household_id, type_key, sensitive_default)
         values ($1, 'vehicle_registration', true)
         on conflict (household_id, type_key) do update set sensitive_default = true`,
        [owner.household_id],
      );
      try {
        const mine = await make(son, {
          title: 'Zain registration, household sensitive',
          type_key: 'vehicle_registration',
          owner_member_id: son.member_id,
        });
        expect(mine.visibility).toBe('private');
        expect(mine.sensitive_effective).toBe(true);
      } finally {
        await admin.query(
          `update document_type_setting set sensitive_default = null
            where household_id = $1 and type_key = 'vehicle_registration'`,
          [owner.household_id],
        );
      }
    });

    it('a capture: the same rule; asked for, as asked', async () => {
      const own = await capture(son, { type_key: 'passport', owner_member_id: son.member_id });
      expect(own.statusCode, own.body).toBe(201);
      const ownId = json<{ document_id: string }>(own).document_id;
      expect(await visibilityOf(son, ownId)).toBe('private');
      const asked = await capture(son, {
        type_key: 'passport',
        owner_member_id: son.member_id,
        visibility: 'household',
      });
      expect(asked.statusCode, asked.body).toBe(201);
      expect(await visibilityOf(son, json<{ document_id: string }>(asked).document_id)).toBe(
        'household',
      );
      const teens = await capture(teen, { type_key: 'passport' });
      expect(teens.statusCode, teens.body).toBe(201);
      expect(await visibilityOf(teen, json<{ document_id: string }>(teens).document_id)).toBe(
        'private',
      );
      const mums = await capture(mum, { type_key: 'passport', owner_member_id: teen.member_id });
      expect(mums.statusCode, mums.body).toBe(201);
      expect(await visibilityOf(mum, json<{ document_id: string }>(mums).document_id)).toBe(
        'household',
      );
    });

    it('a batch’s accept: the same rule; asked for, as asked', async () => {
      const batch = await ok<BatchDetail>(
        call('POST', '/api/v1/batches', { name: 'Zain’s papers' }, son),
        201,
      );
      const item = async () => {
        const form = new FormData();
        form.append('file', PDF(randomUUID()), {
          filename: 'paper.pdf',
          contentType: 'application/pdf',
        });
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/v1/batches/${batch.id}/items`,
          headers: { ...h.as(son), ...form.getHeaders() },
          payload: form.getBuffer(),
        });
        expect(res.statusCode, res.body).toBe(201);
        return json<BatchItemView>(res);
      };
      const accept = async (body: Record<string, unknown>) =>
        ok<BatchAccepted>(
          call('POST', `/api/v1/batches/${batch.id}/items/${(await item()).id}/accept`, body, son),
          201,
        );
      const own = await accept({ type_key: 'passport', owner_member_id: son.member_id });
      expect(await visibilityOf(son, own.document_id)).toBe('private');
      const asked = await accept({
        type_key: 'passport',
        owner_member_id: son.member_id,
        visibility: 'household',
      });
      expect(await visibilityOf(son, asked.document_id)).toBe('household');
      const notSensitive = await accept({
        type_key: 'vehicle_registration',
        owner_member_id: son.member_id,
      });
      expect(await visibilityOf(son, notSensitive.document_id)).toBe('household');
    });
  });

  // ------------------------------------------------------ asked before it goes

  describe('asked before it is shared', () => {
    let passport: DocumentView;
    let registration: DocumentView;

    beforeAll(async () => {
      passport = await withFile(
        owner,
        await make(owner, {
          title: 'H1a family passport',
          type_key: 'passport',
          visibility: 'household',
        }),
        'Aisha passport scan.pdf',
      );
      registration = await withFile(
        owner,
        await make(owner, {
          title: 'H1a car registration',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
    });

    it('a document’s link: 409 sensitive_confirm without the flag, nothing made; made with it', async () => {
      const before = await links();
      const refused = await share(passport.id);
      expect(refused.statusCode).toBe(409);
      expect(codeOf(refused)).toMatchObject({
        code: 'sensitive_confirm',
        message: SENSITIVE_SHARE_CONFIRM,
      });
      expect(await links()).toBe(before);
      await ok<CreatedShare>(share(passport.id, { confirm_sensitive: true }), 201);
      expect(await links()).toBe(before + 1);
      // One that is not sensitive goes as before.
      await ok<CreatedShare>(share(registration.id), 201);
      // A document with no file is answered as before, not asked about.
      const empty = await make(owner, { title: 'H1a nothing yet', type_key: 'passport' });
      const nothing = await share(empty.id);
      expect([nothing.statusCode, codeOf(nothing).code]).toEqual([422, 'nothing_to_share']);
    });

    it('a collection’s link: asked when a sensitive one is ticked, not otherwise', async () => {
      const c = await ok<{ id: string }>(
        call('POST', '/api/v1/collections', { name: 'H1a broker', audience: 'everyone' }),
        201,
      );
      await ok(
        call('POST', `/api/v1/collections/${c.id}/items`, {
          document_ids: [passport.id, registration.id],
        }),
      );
      await fresh(owner);
      await ok<CreatedShare>(
        call('POST', `/api/v1/collections/${c.id}/shares`, { document_ids: [registration.id] }),
        201,
      );
      await fresh(owner);
      const before = await links();
      const refused = await call('POST', `/api/v1/collections/${c.id}/shares`, {
        document_ids: [passport.id, registration.id],
      });
      expect(refused.statusCode).toBe(409);
      expect(codeOf(refused)).toMatchObject({
        code: 'sensitive_confirm',
        message: sensitiveCollectionShareConfirm(1),
      });
      expect(await links()).toBe(before);
      await ok<CreatedShare>(
        call('POST', `/api/v1/collections/${c.id}/shares`, {
          document_ids: [passport.id, registration.id],
          confirm_sensitive: true,
        }),
        201,
      );
      // What the sheet offers says which are sensitive.
      const offered = await ok<{ items: Array<{ document_id: string; sensitive?: boolean }> }>(
        call('GET', `/api/v1/collections/${c.id}/share-preview`),
      );
      expect(Object.fromEntries(offered.items.map((i) => [i.document_id, i.sensitive]))).toEqual({
        [passport.id]: true,
        [registration.id]: false,
      });
    });

    it('a collection whose link keeps up with it: a sensitive one put in asks first; a batch’s puts it in, but not out', async () => {
      const c = await ok<{ id: string }>(
        call('POST', '/api/v1/collections', { name: 'H1a following', audience: 'everyone' }),
        201,
      );
      await ok(
        call('POST', `/api/v1/collections/${c.id}/items`, { document_ids: [registration.id] }),
      );
      await fresh(owner);
      const link = await ok<CreatedShare>(
        call('POST', `/api/v1/collections/${c.id}/shares`, {
          document_ids: [registration.id],
          follow_collection: true,
        }),
        201,
      );
      const followed = async (documentId: string) =>
        (
          await admin.query(
            `select 1 from share_link_item where share_id = $1 and document_id = $2 and kind = 'followed'`,
            [link.share.id, documentId],
          )
        ).rowCount;
      const inIt = async (documentId: string) =>
        (
          await admin.query(
            'select 1 from doc_collection_item where collection_id = $1 and document_id = $2',
            [c.id, documentId],
          )
        ).rowCount;

      const later = await withFile(
        owner,
        await make(owner, {
          title: 'H1a later passport',
          type_key: 'passport',
          visibility: 'household',
        }),
      );
      const refused = await call('POST', `/api/v1/collections/${c.id}/items`, {
        document_ids: [later.id],
      });
      expect(refused.statusCode).toBe(409);
      expect(codeOf(refused)).toMatchObject({
        code: 'sensitive_confirm',
        message: SENSITIVE_FOLLOW_CONFIRM,
      });
      expect(await inIt(later.id)).toBe(0);
      await ok(
        call('POST', `/api/v1/collections/${c.id}/items`, {
          document_ids: [later.id],
          confirm_sensitive: true,
        }),
      );
      expect(await inIt(later.id)).toBe(1);
      expect(await followed(later.id)).toBe(1);

      // Not sensitive: goes as before, nothing asked.
      const car = await withFile(
        owner,
        await make(owner, {
          title: 'H1a second registration',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
      await ok(call('POST', `/api/v1/collections/${c.id}/items`, { document_ids: [car.id] }));
      expect(await followed(car.id)).toBe(1);

      // A collection with no link that keeps up: nothing asked.
      const plain = await ok<{ id: string }>(
        call('POST', '/api/v1/collections', { name: 'H1a plain', audience: 'everyone' }),
        201,
      );
      await ok(call('POST', `/api/v1/collections/${plain.id}/items`, { document_ids: [later.id] }));

      // A batch's paper accepted into it, nobody asked: put in, never sent out — and said so.
      const batch = await ok<BatchDetail>(call('POST', '/api/v1/batches', { name: 'H1a in' }), 201);
      const form = new FormData();
      form.append('file', PDF(randomUUID()), { filename: 'p.pdf', contentType: 'application/pdf' });
      const sent = await h.app.inject({
        method: 'POST',
        url: `/api/v1/batches/${batch.id}/items`,
        headers: { ...h.as(owner), ...form.getHeaders() },
        payload: form.getBuffer(),
      });
      expect(sent.statusCode, sent.body).toBe(201);
      const accepted = await ok<BatchAccepted>(
        call('POST', `/api/v1/batches/${batch.id}/items/${json<BatchItemView>(sent).id}/accept`, {
          title: 'H1a batch passport',
          type_key: 'passport',
          visibility: 'household',
          collection_id: c.id,
        }),
        201,
      );
      expect(await inIt(accepted.document_id)).toBe(1);
      expect(await followed(accepted.document_id)).toBe(0);
      expect(accepted.warnings ?? []).toContain(
        '“H1a batch passport” is sensitive, so the collection’s link outside the family doesn’t include it. Share it on its own if you mean to.',
      );
    });
  });

  // ------------------------------------------------------------ a link's page

  describe('the page a link opens', () => {
    it('a sensitive document is “A document” unless its title is shown; its file named for its type alone', async () => {
      const passport = await withFile(
        owner,
        await make(owner, {
          title: 'Aisha HIV test',
          type_key: 'medical_record',
          visibility: 'household',
        }),
        'Aisha HIV test.pdf',
      );
      const hidden = await ok<CreatedShare>(share(passport.id, { confirm_sensitive: true }), 201);
      const seen = await preview(hidden.link_token);
      expect(seen.document_title).toBe(UNTITLED_ON_LINK);
      const { session, cookie } = await unlock(hidden.link_token);
      expect(session.items).toEqual([
        expect.objectContaining({
          title: UNTITLED_ON_LINK,
          type_label: null,
          filename: 'document.pdf',
        }),
      ]);
      const again = await h.app.inject({
        url: '/api/v1/shared/items',
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      expect(again.statusCode).toBe(200);
      expect(again.body).not.toContain('HIV');
      expect(again.body).not.toContain('Medical');
      const file = await h.app.inject({
        url: `/api/v1/shared/items/${passport.id}/content`,
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toBe("attachment; filename*=UTF-8''document.pdf");
      expect(noIds(seen)).not.toMatch(/HIV/);

      // Shown, by its sharer's choice.
      const shown = await ok<CreatedShare>(
        share(passport.id, { confirm_sensitive: true, show_title: true }),
        201,
      );
      expect((await preview(shown.link_token)).document_title).toBe('Aisha HIV test');
      expect((await unlock(shown.link_token)).session.items[0]?.title).toBe('Aisha HIV test');
    });

    it('any other shows its title, as before, unless the sharer said not; made sensitive since, it is left out', async () => {
      const car = await withFile(
        owner,
        await make(owner, {
          title: 'H1a page registration',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
      const plain = await ok<CreatedShare>(share(car.id), 201);
      expect((await preview(plain.link_token)).document_title).toBe('H1a page registration');
      const quiet = await ok<CreatedShare>(share(car.id, { show_title: false }), 201);
      expect((await preview(quiet.link_token)).document_title).toBe(UNTITLED_ON_LINK);
      // Made sensitive after the link was made: its page leaves the title out now.
      const now = await ok<DocumentView>(call('GET', `/api/v1/documents/${car.id}`));
      await ok(
        call('PATCH', `/api/v1/documents/${car.id}`, { sensitive: true }, owner, {
          'if-match': now.etag,
        }),
      );
      expect((await preview(plain.link_token)).document_title).toBe(UNTITLED_ON_LINK);
    });

    it('a collection’s page: each sensitive one “A document”, the rest by name', async () => {
      const secret = await withFile(
        owner,
        await make(owner, { title: 'H1a will', type_key: 'will', visibility: 'household' }),
      );
      const open = await withFile(
        owner,
        await make(owner, {
          title: 'H1a open registration',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
      const c = await ok<{ id: string }>(
        call('POST', '/api/v1/collections', { name: 'H1a page', audience: 'everyone' }),
        201,
      );
      await ok(
        call('POST', `/api/v1/collections/${c.id}/items`, { document_ids: [secret.id, open.id] }),
      );
      await fresh(owner);
      const link = await ok<CreatedShare>(
        call('POST', `/api/v1/collections/${c.id}/shares`, {
          document_ids: [secret.id, open.id],
          confirm_sensitive: true,
        }),
        201,
      );
      const { session } = await unlock(link.link_token);
      expect(Object.fromEntries(session.items.map((i) => [i.id, i.title]))).toEqual({
        [secret.id]: UNTITLED_ON_LINK,
        [open.id]: 'H1a open registration',
      });
      expect(noIds(session)).not.toMatch(/H1a will/);
    });
  });

  // ------------------------------------------------------- snippets and words

  describe('kept out of search snippets', () => {
    it('a sensitive hit shows its title and no snippet; any other, its snippet as before', async () => {
      await make(owner, {
        title: 'H1a snippet passport',
        type_key: 'passport',
        visibility: 'household',
        notes: 'kept with the quokkasnip papers',
      });
      await make(owner, {
        title: 'H1a snippet registration',
        type_key: 'vehicle_registration',
        visibility: 'household',
        notes: 'kept with the quokkasnip papers',
      });
      const hits = (await ok<{ items: SearchHit[] }>(call('GET', '/api/v1/search?q=quokkasnip')))
        .items;
      const byTitle: Record<string, string> = Object.fromEntries(
        hits.map((h2) => [h2.title ?? '', h2.snippet]),
      );
      expect(byTitle['H1a snippet passport']).toBe('');
      expect(byTitle['H1a snippet registration']).toContain('<em>quokkasnip</em>');
    });

    it('the second pass, of one’s own Only me: the same', async () => {
      await make(son, {
        title: 'H1a sealed passport',
        type_key: 'passport',
        owner_member_id: son.member_id,
        notes: 'the wombatsnip number',
      });
      await make(son, {
        title: 'H1a sealed registration',
        type_key: 'vehicle_registration',
        owner_member_id: son.member_id,
        visibility: 'private',
        notes: 'the wombatsnip number',
      });
      const first = await ok<{ sealed_pending: { token?: string } }>(
        call('GET', '/api/v1/search?q=wombatsnip', undefined, son),
      );
      const second = await ok<{ items: SearchHit[] }>(
        call(
          'GET',
          `/api/v1/search/sealed?token=${encodeURIComponent(first.sealed_pending.token as string)}`,
          undefined,
          son,
        ),
      );
      const byTitle: Record<string, string> = Object.fromEntries(
        second.items.map((h2) => [h2.title ?? '', h2.snippet]),
      );
      expect(byTitle['H1a sealed passport']).toBe('');
      expect(byTitle['H1a sealed registration']).toContain('<em>wombatsnip</em>');
    });
  });

  describe('the activity log’s words', () => {
    it('whoever can open it reads “a sensitive document”, and taps through; whoever cannot, nothing', async () => {
      const secret = await make(owner, {
        title: 'H1a Adoption papers',
        type_key: 'passport',
        visibility: 'adults',
      });
      const open = await make(owner, {
        title: 'H1a Boiler registration',
        type_key: 'vehicle_registration',
        visibility: 'household',
      });
      const lines = await audit(owner);
      const about = (id: string) => lines.filter((l) => l.document_id === id).map((l) => l.text);
      expect(about(secret.id)).toContain('Owner added a sensitive document');
      expect(about(open.id)).toContain('Owner added “H1a Boiler registration”');
      expect(noIds(lines)).not.toMatch(/Adoption/);
      // Opened, by its id: whoever may open it gets there.
      await ok(call('GET', `/api/v1/documents/${secret.id}`));

      // A teen cannot open an adults-only document: no line about it at all.
      const teens = await audit(teen);
      expect(teens.some((l) => l.document_id === secret.id)).toBe(false);
      expect(noIds(teens)).not.toMatch(/Adoption/);
      // A sensitive one the teen can open: its line, in the same words.
      const shared = await make(owner, {
        title: 'H1a Family passport',
        type_key: 'passport',
        visibility: 'household',
      });
      expect(
        (await audit(teen)).filter((l) => l.document_id === shared.id).map((l) => l.text),
      ).toContain('Owner added a sensitive document');
    });

    it('an Only me sensitive one: its owner reads the line, nobody else does', async () => {
      const mine = await make(son, {
        title: 'H1a Zain therapy letter',
        type_key: 'medical_record',
        owner_member_id: son.member_id,
      });
      expect(mine.visibility).toBe('private');
      expect(
        (await audit(son)).filter((l) => l.document_id === mine.id).map((l) => l.text),
      ).toContain('Zain added a sensitive document');
      const owners = await audit(owner);
      expect(owners.some((l) => l.document_id === mine.id)).toBe(false);
      expect(noIds(owners)).not.toMatch(/therapy/i);
    });
  });

  describe('counts', () => {
    it('nothing counts a grown-up child’s Only me sensitive paper for anybody else', async () => {
      const tag = 'h1acounttag';
      const counts = async (who: Tokens) => ({
        counts: await ok<{ by_member: Array<{ member_id: string | null; count: number }> }>(
          call('GET', '/api/v1/documents/counts', undefined, who),
        ),
        members: (
          await ok<{ items: Array<{ id: string; document_count: number }> }>(
            call('GET', '/api/v1/members', undefined, who),
          )
        ).items.find((m) => m.id === son.member_id)?.document_count,
        sensitive: (
          await ok<{ total: number }>(
            call('GET', '/api/v1/documents?sensitive=yes&sort=title&limit=1', undefined, who),
          )
        ).total,
        tags: noIds(await ok(call('GET', `/api/v1/tags?q=${tag}`, undefined, who))),
        search: await ok<{ items: SearchHit[]; sealed_pending: { count: number } }>(
          call('GET', '/api/v1/search?q=Zainscan', undefined, who),
        ),
      });
      const before = {
        owner: await counts(owner),
        mum: await counts(mum),
        teen: await counts(teen),
      };
      const made = await make(son, {
        title: 'Zainscan blood test',
        type_key: 'medical_record',
        owner_member_id: son.member_id,
        tags: [tag],
      });
      expect(made.visibility).toBe('private');
      for (const [name, who] of [
        ['owner', owner],
        ['mum', mum],
        ['teen', teen],
      ] as const) {
        const now = await counts(who);
        expect(now.counts, name).toEqual(before[name].counts);
        expect(now.members, name).toBe(before[name].members);
        expect(now.sensitive, name).toBe(before[name].sensitive);
        expect(now.tags, name).not.toContain(tag);
        expect(now.search.items, name).toEqual([]);
        expect(now.search.sealed_pending.count, name).toBe(
          before[name].search.sealed_pending.count,
        );
      }
      // Its owner counts it.
      const his = await counts(son);
      expect(his.search.sealed_pending.count).toBeGreaterThan(0);
      expect(his.tags).toContain(tag);
    });
  });
  // ------------------------------------------------------- the review (H1a)

  describe('the review', () => {
    const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest();
    /** A link as 0.5.13 made them (A25): put there directly, nothing makes one now. */
    const legacyLink = async (documentId: string) => {
      const token = randomBytes(32).toString('base64url');
      const made = await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [owner.member_id],
      );
      await admin.query(
        `insert into share_link (household_id, document_id, token_hash, created_by, expires_at, flow)
         values ($1, $2, $3, $4, now() + interval '7 days', 'legacy')`,
        [owner.household_id, documentId, sha256(token), made.rows[0]?.account_id],
      );
      return token;
    };

    it('S1: every legacy route leaves a sensitive one’s title, kind and file name out', async () => {
      const doc = await withFile(
        owner,
        await make(owner, {
          title: 'H1a legacy HIV test',
          type_key: 'medical_record',
          visibility: 'household',
        }),
        'Aisha HIV test.pdf',
      );
      const token = await legacyLink(doc.id);
      const seen = await h.app.inject({ url: `/api/v1/shared/${token}`, ...peer() });
      expect(seen.statusCode, seen.body).toBe(200);
      expect(json<{ document_title: string }>(seen).document_title).toBe(UNTITLED_ON_LINK);
      const opened = await h.app.inject({
        method: 'POST',
        url: `/api/v1/shared/${token}/open`,
        payload: {},
        ...peer(),
      });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(json(opened)).toMatchObject({
        document_title: UNTITLED_ON_LINK,
        document_type: null,
        filename: 'document.pdf',
      });
      const file = await h.app.inject({ url: `/api/v1/shared/${token}/content`, ...peer() });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toBe("attachment; filename*=UTF-8''document.pdf");
      for (const r of [seen, opened, file]) {
        expect(String(r.headers['content-disposition'] ?? '') + r.body.slice(0, 2000)).not.toMatch(
          /HIV|Medical/,
        );
      }
      // Not sensitive: as before.
      const car = await withFile(
        owner,
        await make(owner, {
          title: 'H1a legacy registration',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
        'car.pdf',
      );
      const plain = await legacyLink(car.id);
      expect(
        json<{ document_title: string }>(
          await h.app.inject({ url: `/api/v1/shared/${plain}`, ...peer() }),
        ).document_title,
      ).toBe('H1a legacy registration');
      const carFile = await h.app.inject({ url: `/api/v1/shared/${plain}/content`, ...peer() });
      expect(carFile.headers['content-disposition']).toBe("attachment; filename*=UTF-8''car.pdf");
    });

    it('S2: made sensitive while shared — by its own choice, or a kind that is — the edit is made, and the answer says how many links still give it', async () => {
      const car = await withFile(
        owner,
        await make(owner, {
          title: 'H1a S2 registration',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
      await ok<CreatedShare>(share(car.id), 201);
      await ok<CreatedShare>(share(car.id, { permission: 'view' }), 201);
      const now = await ok<DocumentView>(call('GET', `/api/v1/documents/${car.id}`));
      const edited = await ok<DocumentView>(
        call('PATCH', `/api/v1/documents/${car.id}`, { sensitive: true }, owner, {
          'if-match': now.etag,
        }),
      );
      expect(edited.sensitive_effective).toBe(true);
      expect(edited.warnings).toEqual([{ code: 'sensitive_still_shared', links: 2 }]);
      // Already sensitive: another edit says nothing more.
      const again = await ok<DocumentView>(
        call('PATCH', `/api/v1/documents/${car.id}`, { title: 'H1a S2 registration, 2' }, owner, {
          'if-match': edited.etag,
        }),
      );
      expect(again.warnings).toBeUndefined();

      // A kind that is sensitive, chosen: the same.
      const bill = await withFile(
        owner,
        await make(owner, {
          title: 'H1a S2 statement',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
      await ok<CreatedShare>(share(bill.id), 201);
      const before = await ok<DocumentView>(call('GET', `/api/v1/documents/${bill.id}`));
      const kinded = await ok<DocumentView>(
        call('PATCH', `/api/v1/documents/${bill.id}`, { type_key: 'passport' }, owner, {
          'if-match': before.etag,
        }),
      );
      expect(kinded.warnings).toEqual([{ code: 'sensitive_still_shared', links: 1 }]);

      // Not shared: nothing said.
      const lone = await make(owner, {
        title: 'H1a S2 lone',
        type_key: 'vehicle_registration',
        visibility: 'household',
      });
      const quiet = await ok<DocumentView>(
        call('PATCH', `/api/v1/documents/${lone.id}`, { sensitive: true }, owner, {
          'if-match': lone.etag,
        }),
      );
      expect(quiet.warnings).toBeUndefined();
    });

    it('S2: ending them — its own links taken back, a collection’s made to leave it out, the rest of the collection still going', async () => {
      const doc = await withFile(
        owner,
        await make(owner, {
          title: 'H1a S2 ended',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
      const other = await withFile(
        owner,
        await make(owner, {
          title: 'H1a S2 stays',
          type_key: 'vehicle_registration',
          visibility: 'household',
        }),
      );
      const own = await ok<CreatedShare>(share(doc.id), 201);
      const c = await ok<{ id: string }>(
        call('POST', '/api/v1/collections', { name: 'H1a S2 box', audience: 'everyone' }),
        201,
      );
      // A link that keeps up with it, made first; then the paper put in follows it.
      await ok(call('POST', `/api/v1/collections/${c.id}/items`, { document_ids: [other.id] }));
      await fresh(owner);
      const following = await ok<CreatedShare>(
        call('POST', `/api/v1/collections/${c.id}/shares`, {
          document_ids: [other.id],
          follow_collection: true,
        }),
        201,
      );
      await ok(call('POST', `/api/v1/collections/${c.id}/items`, { document_ids: [doc.id] }));
      // And a link made with both ticked.
      await fresh(owner);
      const ticked = await ok<CreatedShare>(
        call('POST', `/api/v1/collections/${c.id}/shares`, { document_ids: [doc.id, other.id] }),
        201,
      );
      const now = await ok<DocumentView>(call('GET', `/api/v1/documents/${doc.id}`));
      const edited = await ok<DocumentView>(
        call('PATCH', `/api/v1/documents/${doc.id}`, { sensitive: true }, owner, {
          'if-match': now.etag,
        }),
      );
      expect(edited.warnings).toEqual([{ code: 'sensitive_still_shared', links: 3 }]);

      const ended = await ok(call('POST', `/api/v1/documents/${doc.id}/stop-sharing`));
      expect(ended).toEqual({ ended: 1, left_out: 2, kept: 0 });
      // Its own link: taken back.
      const ownPage = await h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/preview',
        payload: { token: own.link_token },
        ...peer(),
      });
      expect([404, 410]).toContain(ownPage.statusCode);
      // The collections' links: the rest still goes, it does not.
      for (const link of [ticked, following]) {
        const { session } = await unlock(link.link_token);
        expect(session.items.map((i) => i.id)).toEqual([other.id]);
      }
      // Out and back in: it never follows again.
      expect((await call('DELETE', `/api/v1/collections/${c.id}/items/${doc.id}`)).statusCode).toBe(
        204,
      );
      await ok(
        call('POST', `/api/v1/collections/${c.id}/items`, {
          document_ids: [doc.id],
          confirm_sensitive: true,
        }),
      );
      expect((await unlock(following.link_token)).session.items.map((i) => i.id)).toEqual([
        other.id,
      ]);
      // Nothing more to end, and nothing said by the next edit.
      expect(await ok(call('POST', `/api/v1/documents/${doc.id}/stop-sharing`))).toEqual({
        ended: 0,
        left_out: 0,
        kept: 0,
      });
      // Said in the activity log, to whoever may see it.
      const lines = (await audit(owner)).filter((l) => l.document_id === doc.id).map((l) => l.text);
      expect(lines).toContain(
        'Owner took a sensitive document out of a link to the collection “H1a S2 box”, so it no longer goes outside the family',
      );
      // Who may not share may not end them either.
      const refused = await call(
        'POST',
        `/api/v1/documents/${doc.id}/stop-sharing`,
        undefined,
        teen,
      );
      expect([403, 404]).toContain(refused.statusCode);
    });

    it('S2: a kind made sensitive by default says how many of its documents are still shared; nothing is ended', async () => {
      const car = await withFile(
        owner,
        await make(owner, {
          title: 'H1a S2 kind car',
          type_key: 'insurance_policy',
          visibility: 'household',
        }),
      );
      await ok<CreatedShare>(share(car.id), 201);
      const before = await ok<{ items: DocumentTypeView[] }>(
        call('GET', '/api/v1/document-types?all=true'),
      );
      const kind = before.items.find((t) => t.key === 'insurance_policy') as DocumentTypeView;
      expect(kind.sensitive_default).toBe(false);
      try {
        const changed = await ok<DocumentTypeView>(
          call(
            'PATCH',
            '/api/v1/document-types/insurance_policy',
            { sensitive_default: true },
            owner,
            {
              'if-match': kind.etag as string,
            },
          ),
        );
        expect(changed.warnings).toEqual([{ code: 'sensitive_still_shared', documents: 1 }]);
        expect(await links()).toBeGreaterThan(0);
        const off = await ok<DocumentTypeView>(
          call(
            'PATCH',
            '/api/v1/document-types/insurance_policy',
            { sensitive_default: false },
            owner,
            {
              'if-match': changed.etag as string,
            },
          ),
        );
        expect(off.warnings).toBeUndefined();
      } finally {
        await admin.query(
          `update document_type_setting set sensitive_default = null
            where household_id = $1 and type_key = 'insurance_policy'`,
          [owner.household_id],
        );
      }
    });

    it('M1: a paused link that gives a sensitive document is turned back on only when asked', async () => {
      const doc = await withFile(
        owner,
        await make(owner, {
          title: 'H1a resumed passport',
          type_key: 'passport',
          visibility: 'household',
          is_essential: false,
        }),
      );
      const made = await ok<CreatedShare>(share(doc.id, { confirm_sensitive: true }), 201);
      await admin.query(
        `update share_link set paused_at = now(), paused_reason = 'restored' where id = $1`,
        [made.share.id],
      );
      await fresh(owner);
      const refused = await call('POST', `/api/v1/shares/${made.share.id}/resume`);
      expect(refused.statusCode).toBe(409);
      expect(codeOf(refused)).toMatchObject({
        code: 'sensitive_confirm',
        message: sensitiveResumeConfirm(1),
      });
      const still = await admin.query<{ paused_at: Date | null }>(
        'select paused_at from share_link where id = $1',
        [made.share.id],
      );
      expect(still.rows[0]?.paused_at).not.toBeNull();
      await ok(call('POST', `/api/v1/shares/${made.share.id}/resume`, { confirm_sensitive: true }));
      expect((await preview(made.link_token)).document_title).toBe(UNTITLED_ON_LINK);
    });

    it('M2: a sensitive note found by search gives no first words for a name', async () => {
      const note = await make(owner, {
        title: null,
        type_key: 'note',
        visibility: 'household',
        notes: 'Zebrafinch lockbox code is 4471',
        sensitive: true,
      });
      const open = await make(owner, {
        title: null,
        type_key: 'note',
        visibility: 'household',
        notes: 'Zebrafinch feeder goes in the garden',
      });
      const hits = (await ok<{ items: SearchHit[] }>(call('GET', '/api/v1/search?q=zebrafinch')))
        .items;
      const byId = new Map(hits.map((x) => [x.document_id, x]));
      expect(byId.get(note.id)).toBeDefined();
      expect(byId.get(note.id)?.note_name).toBeUndefined();
      expect(byId.get(note.id)?.snippet).toBe('');
      expect(byId.get(open.id)?.note_name).toBe('Zebrafinch feeder goes in the garden');
      expect(noIds(byId.get(note.id))).not.toMatch(/lockbox|4471/);
    });
  });
});
