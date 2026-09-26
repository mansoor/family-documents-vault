import { CATEGORY_LABELS, CORE_FIELDS, type Tokens } from '@fdv/shared';
import { expect } from 'vitest';
import type { Api } from '../api.js';
import { ApiRequestError, isSessionOver } from '../errors.js';
import { multipartBody } from '../multipart.js';
import { negotiate } from '../negotiate.js';

/**
 * What any vault a client talks to must do — the real API and the fake
 * alike. `apps/api/src/client-contract.test.ts` runs these against the
 * real server through `@fdv/client`; `fake.test.ts` runs them against
 * `createFakeVault()`. A client tested against the fake is then tested
 * against something that behaves like the server where it matters.
 *
 * They run in order against one fresh vault, sharing `ContractContext`.
 */

export interface ContractContext {
  email: string;
  password: string;
  tokens?: Tokens;
  spent?: string;
  /**
   * Hides a type for the household, as a household can from 0.5.6 on: the
   * real API's run asks it to (`PATCH /document-types/{key}`, 0.5.10), the
   * fake's marks its type — so the scenarios an older client carries,
   * which have no call for it, can still hide one.
   */
  hideType: (householdId: string, key: string) => Promise<void>;
}

export interface Scenario {
  name: string;
  run: (api: Api, ctx: ContractContext) => Promise<void>;
}

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const CAPTURE_KEY = '4f1c2b3a-9d8e-4c7b-8a6f-5e4d3c2b1a09';
const RACE_KEY = '8e7d6c5b-4a39-4281-9f0e-1d2c3b4a5f6e';
const NEVER_USED = 'c0ffee00-1234-4567-89ab-cdef01234567';
const DETAILS_KEY = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const LATE_KEY = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const ISSUER_KEY = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091';
const PAGES_KEY = '3c4d5e6f-7081-4923-8a4b-5c6d7e8f9012';
const EXTRA_KEY = '4d5e6f70-8192-4a34-9b5c-6d7e8f901234';
const REFUSED_EXTRA_KEY = '5e6f7081-92a3-4b45-8c6d-7e8f90123456';
const GONE_KIND_KEY = '6f708192-a3b4-4c56-9d7e-8f9012345678';
const OWN_KIND_KEY = '708192a3-b4c5-4d67-8e8f-90123456789a';

async function refusal(p: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRequestError);
    return err as ApiRequestError;
  }
  throw new Error('expected the vault to refuse');
}

const signIn = async (api: Api, ctx: ContractContext): Promise<Tokens> => {
  const t = await api.signIn(ctx.email, ctx.password);
  expect('access_token' in t).toBe(true);
  return t as Tokens;
};

export const contractScenarios: Scenario[] = [
  {
    name: 'a new vault says what it is, and that it needs setting up',
    run: async (api) => {
      const outcome = negotiate(await api.capabilities(), {
        clientVersion: '0.1.0',
        // About setup, not versions: every server version is new enough.
        minServerVersion: '0.0.0',
      });
      expect(outcome.kind).toBe('setup_required');
    },
  },
  {
    name: 'setting it up opens a session for the first owner',
    run: async (api, ctx) => {
      const t = await api.setup({
        household_name: 'The Contract family',
        display_name: 'Owner',
        email: ctx.email,
        password: ctx.password,
      });
      expect(t.role).toBe('owner');
      expect(t.access_token).toBeTruthy();
      expect(t.refresh_token).toBeTruthy();
      ctx.tokens = t;
    },
  },
  {
    name: 'a wrong password is an ordinary refusal, not a dead session',
    run: async (api, ctx) => {
      const err = await refusal(api.signIn(ctx.email, 'not the right password'));
      expect(err.status).toBe(401);
      expect(err.code).toBe('invalid_credentials');
      expect(isSessionOver(err)).toBe(false);
    },
  },
  {
    name: 'refreshing rotates the refresh token',
    run: async (api, ctx) => {
      const before = await signIn(api, ctx);
      const after = await api.refresh(before.refresh_token);
      expect(after.refresh_token).not.toBe(before.refresh_token);
      expect(after.access_token).toBeTruthy();
      ctx.spent = before.refresh_token;
      ctx.tokens = after;
    },
  },
  {
    name: 'a spent refresh token, presented again, ends the whole session',
    run: async (api, ctx) => {
      const replay = await refusal(api.refresh(ctx.spent as string));
      expect(replay.status).toBe(401);
      expect(isSessionOver(replay)).toBe(true);
      // The thief's replay took the real holder's session with it.
      const holder = await refusal(api.refresh((ctx.tokens as Tokens).refresh_token));
      expect(isSessionOver(holder)).toBe(true);
    },
  },
  {
    name: 'a document created is a document listed',
    run: async (api, ctx) => {
      const t = await signIn(api, ctx);
      ctx.tokens = t;
      const doc = await api.createDocument(t.access_token, { title: 'Contract water bill' });
      const page = await api.documents(t.access_token);
      expect(page.items.map((d) => d.id)).toContain(doc.id);
    },
  },
  {
    name: 'a capture sent as bytes is stored once, however often it is retried',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const form = multipartBody([
        { name: 'file', filename: 'scan.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      const body = { kind: 'bytes' as const, bytes: form.bytes, contentType: form.contentType };
      const first = await api.capture(token, body, CAPTURE_KEY);
      expect(first.document_id).toBeTruthy();
      const again = await api.capture(token, body, CAPTURE_KEY);
      expect(again.document_id).toBe(first.document_id);
      expect(again.version_id).toBe(first.version_id);
    },
  },
  {
    name: 'a retry never duplicates: two at once make one document, and the key says which',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const form = multipartBody([
        { name: 'file', filename: 'race.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      const body = { kind: 'bytes' as const, bytes: form.bytes, contentType: form.contentType };
      const before = (await api.documents(token)).items.length;
      const tries = await Promise.allSettled([
        api.capture(token, body, RACE_KEY),
        api.capture(token, body, RACE_KEY),
      ]);
      // Each try is the one document, or told the other is on its way.
      for (const t of tries) {
        if (t.status === 'rejected') {
          expect(t.reason).toBeInstanceOf(ApiRequestError);
          expect((t.reason as ApiRequestError).code).toBe('upload_in_progress');
          expect((t.reason as ApiRequestError).retriable).toBe(true);
        }
      }
      const status = await api.uploadStatus(token, RACE_KEY);
      if (status.state !== 'done') throw new Error(`expected done, got ${status.state}`);
      for (const t of tries) {
        if (t.status === 'fulfilled') expect(t.value.document_id).toBe(status.document_id);
      }
      const again = await api.capture(token, body, RACE_KEY);
      expect(again.document_id).toBe(status.document_id);
      expect(again.version_id).toBe(status.version_id);
      expect((await api.documents(token)).items.length).toBe(before + 1);
    },
  },
  {
    name: 'a key never used is not known, and a capture key cannot add a version',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await refusal(api.uploadStatus(token, NEVER_USED))).status).toBe(404);
      const made = await api.uploadStatus(token, CAPTURE_KEY);
      if (made.state !== 'done') throw new Error(`expected done, got ${made.state}`);
      const form = multipartBody([
        { name: 'file', filename: 'other.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      const body = { kind: 'bytes' as const, bytes: form.bytes, contentType: form.contentType };
      const err = await refusal(api.upload(token, made.document_id, body, CAPTURE_KEY));
      expect(err.status).toBe(409);
      expect(err.code).toBe('idempotency_key_reused');
      // It does not say what the key made: that could be somebody else's.
      expect(JSON.stringify(err)).not.toContain(made.version_id);
    },
  },
  {
    name: 'a capture carries its details; details sent after the file are refused, and nothing is kept',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const me = await api.me(token);
      const made = await api.capture(
        token,
        {
          metadata: {
            type_key: 'passport',
            title: 'Contract passport',
            owner_member_id: me.member_id,
            visibility: 'private',
          },
          file: {
            kind: 'bytes',
            filename: 'passport.pdf',
            contentType: 'application/pdf',
            bytes: PDF,
          },
        },
        DETAILS_KEY,
      );
      const listed = (await api.documents(token)).items.find((d) => d.id === made.document_id);
      expect(listed).toMatchObject({
        title: 'Contract passport',
        type_key: 'passport',
        owner_member_id: me.member_id,
        visibility: 'private',
      });

      const late = multipartBody([
        { name: 'file', filename: 'late.pdf', contentType: 'application/pdf', bytes: PDF },
        { name: 'metadata', value: JSON.stringify({ title: 'Too late' }) },
      ]);
      const err = await refusal(
        api.capture(
          token,
          { kind: 'bytes', bytes: late.bytes, contentType: late.contentType },
          LATE_KEY,
        ),
      );
      expect(err.status).toBe(422);
      expect(err.message).toBe('Send the details before the file.');
      expect((await refusal(api.uploadStatus(token, LATE_KEY))).status).toBe(404);
    },
  },
  {
    name: "a document says who issued it, and the household's issuers are listed and filter the list",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.issued_by).toBe(true);
      const made = await api.capture(
        token,
        {
          metadata: { type_key: 'bank_statement', issued_by: '  Contract   Bank ' },
          file: {
            kind: 'bytes',
            filename: 'statement.pdf',
            contentType: 'application/pdf',
            bytes: PDF,
          },
        },
        ISSUER_KEY,
      );
      const listed = (await api.documents(token, { issued_by: 'contract bank' })).items;
      expect(listed.map((d) => d.id)).toEqual([made.document_id]);
      expect(listed[0]?.issued_by).toBe('Contract Bank');
      const issuers = (await api.issuers(token)).items;
      expect(issuers).toContainEqual({ issued_by: 'Contract Bank', count: 1 });
      // Narrowed: a prefix, whatever the case; and only those used for a type.
      const names = async (params: Record<string, string>) =>
        (await api.issuers(token, params)).items.map((i) => i.issued_by);
      expect(await names({ q: 'contr' })).toContain('Contract Bank');
      expect(await names({ q: 'zz' })).not.toContain('Contract Bank');
      expect(await names({ type_key: 'bank_statement' })).toContain('Contract Bank');
      expect(await names({ type_key: 'passport' })).not.toContain('Contract Bank');
      // Typed in, not captured: kept the same way.
      const typed = await api.createDocument(token, {
        title: 'Contract letter',
        issued_by: ' Contract   Council ',
      });
      expect(typed.issued_by).toBe('Contract Council');
      // Pages nobody has read yet are not guessed at.
      const offered = await api.issuerSuggestions(token, made.document_id);
      expect(['pending', 'unavailable']).toContain(offered.state);
      expect(offered.items).toEqual([]);
    },
  },
  {
    name: 'a page not yet drawn is on its way, and says to ask again in a moment (0.4.12)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.page_previews).toBe(true);
      const made = await api.capture(
        token,
        {
          file: {
            kind: 'bytes',
            filename: 'pages.pdf',
            contentType: 'application/pdf',
            bytes: PDF,
          },
        },
        PAGES_KEY,
      );
      // Asked twice, it is still on its way: the same answer each time.
      for (let i = 0; i < 2; i += 1) {
        const pending = await refusal(api.page(token, made.version_id, 1));
        expect(pending.status).toBe(404);
        expect(pending.code).toBe('preview_pending');
        expect(pending.retriable).toBe(true);
        expect(pending.retryAfterSeconds).toBe(3);
      }
      // Past the pages the vault draws: those are opened by saving a copy.
      const past = await refusal(api.page(token, made.version_id, 31));
      expect(past.code).toBe('no_preview');
      expect(past.retriable).toBe(false);
      // A version that is not there is not there; page 0 is not a page.
      expect((await refusal(api.page(token, NEVER_USED, 1))).code).toBe('not_found');
      expect((await refusal(api.page(token, made.version_id, 0))).status).toBe(422);
    },
  },
  {
    name: 'a phone keeps Essentials only as the vault says, and only with a grant (0.4.13)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.offline_essentials).toBe(true);
      const set = await api.offlineEssentials(token);
      expect(set).toMatchObject({ grant: null, truncated: false });
      expect(Array.isArray(set.items)).toBe(true);
      expect(set.max_offline_days).toBeGreaterThan(0);
      // Only an app keeps documents: a session with no installation id is refused.
      const noApp = await refusal(api.offlineGrant(token, ctx.password));
      expect(noApp.status).toBe(422);
      // A page of a version that is not there is not there.
      expect((await refusal(api.offlinePage(token, NEVER_USED, 1))).code).toBe('not_found');
      // An open about something that is not there is dropped, not recorded.
      const told = await api.offlineOpens(token, [
        {
          id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
          version_id: NEVER_USED,
          opened_at: new Date().toISOString(),
          mode: 'view',
          online: false,
        },
      ]);
      expect(told).toEqual({ accepted: 0, duplicates: 0, dropped: 1 });
    },
  },
  {
    name: 'GET /document-types answers the old shape plus the new fields',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const { items } = await api.documentTypes(token);
      expect(items.length).toBeGreaterThan(0);
      for (const t of items) {
        // What every client has read from the start, app 0.2.0 included…
        const kinds = {
          key: typeof t.key,
          label: typeof t.label,
          category: typeof t.category,
          fields: Array.isArray(t.fields),
          reminder_leads: Array.isArray(t.reminder_leads),
          usually_essential: typeof t.usually_essential,
          default_visibility: typeof t.default_visibility,
        };
        expect(kinds).toEqual({
          key: 'string',
          label: 'string',
          category: 'string',
          fields: true,
          reminder_leads: true,
          usually_essential: 'boolean',
          default_visibility: 'string',
        });
        expect(t).toHaveProperty('expiry_driver');
        expect(t).toHaveProperty('issued_by_label');
        // …and what 0.5.6 added: nothing is hidden until a household hides it.
        expect(t.hidden).toBe(false);
        expect(typeof t.builtin).toBe('boolean');
        expect(t).toHaveProperty('short_label');
        expect(t).toHaveProperty('issuer_noun');
        expect(Object.keys(t.core ?? {}).sort()).toEqual([...CORE_FIELDS].sort());
        for (const rule of Object.values(t.core ?? {})) {
          expect(typeof rule.shown).toBe('boolean');
          expect(typeof rule.required).toBe('boolean');
          expect(rule.label === null || typeof rule.label === 'string').toBe(true);
        }
        for (const f of t.fields) expect(typeof f.required).toBe('boolean');
      }
      const type = (key: string) => items.find((t) => t.key === key);
      expect(type('passport')).toMatchObject({
        builtin: true,
        expiry_driver: 'expires_on',
        issued_by_label: 'Issuing country',
        core: {
          // What makes a passport of use (0.5.7): its number, by that name, and its expiry.
          identifier: { shown: true, required: true, label: 'Passport number' },
          expires: { shown: true, required: true, label: null },
          issued_by: { shown: true, required: false, label: 'Issuing country' },
        },
      });
      // A type that does not expire does not show an expiry.
      expect(type('bank_statement')).toMatchObject({
        short_label: 'Bank statement',
        issuer_noun: 'statement',
        core: { expires: { shown: false } },
      });
      // The library a type's own fields come from.
      expect((await api.documentAttributes(token)).items).toContainEqual({
        key: 'account_last4',
        label: 'Account (last 4)',
        kind: 'text',
        choices: null,
        builtin: true,
      });
    },
  },
  {
    name: 'a hidden type still in use stays in the default list, as the 0.2.0 client needs',
    run: async (api, ctx) => {
      const t = ctx.tokens as Tokens;
      // App 0.2.0 keeps this list to look each document's type up by key,
      // offline: a passport's expiry comes from its type. A passport was
      // captured above; nothing is a birth certificate.
      await ctx.hideType(t.household_id, 'passport');
      await ctx.hideType(t.household_id, 'birth_certificate');
      const listed = (await api.documentTypes(t.access_token)).items;
      expect(listed.find((x) => x.key === 'passport')).toMatchObject({
        hidden: true,
        label: 'Passport',
        expiry_driver: 'expires_on',
        reminder_leads: [270, 180],
      });
      // Hidden and unused: no longer offered.
      expect(listed.map((x) => x.key)).not.toContain('birth_certificate');
      expect(listed.find((x) => x.key === 'bank_statement')?.hidden).toBe(false);
      // Every type, when asked for all of them.
      const all = (await api.documentTypes(t.access_token, { all: true })).items;
      expect(all.find((x) => x.key === 'birth_certificate')?.hidden).toBe(true);
      expect(all.length).toBe(listed.length + 1);
    },
  },
  {
    name: "a type's details are kept from the capture, merged by an edit, and a missing one is Needs info (0.5.7)",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const me = await api.me(token);
      const file = {
        kind: 'bytes' as const,
        filename: 'certificate.pdf',
        contentType: 'application/pdf',
        bytes: PDF,
      };
      // Hidden above, and still taken: a phone queued it against the list it had.
      const made = await api.capture(
        token,
        {
          metadata: {
            type_key: 'birth_certificate',
            owner_member_id: me.member_id,
            extra: { registration_no: '  R-1234 ', place_of_birth: 'Leeds' },
          },
          file,
        },
        EXTRA_KEY,
      );
      const doc = await api.document(token, made.document_id);
      expect(doc.extra).toEqual({ registration_no: 'R-1234', place_of_birth: 'Leeds' });
      expect(doc.status.value).toBe('valid');

      // An edit merges: what it leaves out stays, and null takes a key away.
      const edited = await api.updateDocument(token, doc.id, { extra: { place_of_birth: null } });
      expect(edited.extra).toEqual({ registration_no: 'R-1234' });

      // A detail the type does not have, or of the wrong kind, is refused and named.
      const unknown = await refusal(
        api.updateDocument(token, doc.id, { extra: { shoe_size: '9' } }),
      );
      expect(unknown).toMatchObject({ status: 422, code: 'invalid_extra', detail: 'shoe_size' });
      expect(unknown.message).toContain('shoe_size');
      const wrong = await refusal(
        api.updateDocument(token, doc.id, { extra: { registration_no: 1234 } }),
      );
      expect(wrong).toMatchObject({
        status: 422,
        code: 'invalid_extra',
        detail: 'registration_no',
      });

      // An edit to a version somebody has since changed is refused, not
      // laid over theirs; one to the version as it is now goes through.
      const stale = await refusal(api.updateDocument(token, doc.id, { title: 'Mine' }, doc.etag));
      expect(stale).toMatchObject({ status: 409, code: 'conflict' });
      const fresh = await api.updateDocument(token, doc.id, { title: 'Mine' }, edited.etag);
      expect(fresh.title).toBe('Mine');
      const refused = await refusal(
        api.capture(
          token,
          { metadata: { type_key: 'birth_certificate', extra: { shoe_size: '9' } }, file },
          REFUSED_EXTRA_KEY,
        ),
      );
      expect(refused).toMatchObject({ status: 422, code: 'invalid_extra', detail: 'shoe_size' });
      expect((await refusal(api.uploadStatus(token, REFUSED_EXTRA_KEY))).status).toBe(404);

      // A passport with no number is kept, and says what it needs.
      const passport = await api.createDocument(token, {
        type_key: 'passport',
        title: 'Contract passport, no number',
        owner_member_id: me.member_id,
        expires: { date: '2036-03-31', precision: 'month' },
      });
      expect(passport.status).toEqual({ value: 'needs_info', label: 'Needs a passport number' });
      const numbered = await api.updateDocument(token, passport.id, { identifier: '563914782' });
      expect(numbered.status.value).toBe('active');
    },
  },
  {
    name: "an Only me document's notes and details are on its own page, and not in a list (0.5.8)",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const me = await api.me(token);
      const made = await api.createDocument(token, {
        type_key: 'bank_statement',
        title: 'Contract savings',
        owner_member_id: me.member_id,
        visibility: 'private',
        notes: '  Kept in the blue folder ',
        extra: { period: 'March 2026' },
      });
      // Its owner, asking for it, reads them.
      const kept = { notes: 'Kept in the blue folder', has_notes: true };
      expect(made).toMatchObject({ ...kept, extra: { period: 'March 2026' } });
      expect(await api.document(token, made.id)).toMatchObject({
        ...kept,
        extra: { period: 'March 2026' },
      });
      // A list says it has notes, and shows neither them nor its details.
      const listed = async (id: string) =>
        (await api.documents(token)).items.find((d) => d.id === id);
      expect(await listed(made.id)).toMatchObject({ notes: null, has_notes: true, extra: {} });
      // One the family can see is listed as it is.
      const shared = await api.createDocument(token, {
        type_key: 'bank_statement',
        title: 'Contract current account',
        owner_member_id: me.member_id,
        visibility: 'household',
        notes: 'Joint',
      });
      expect(await listed(shared.id)).toMatchObject({ notes: 'Joint', has_notes: true });
    },
  },
  {
    name: "a household's own kind of document: made, renamed under the same key, archived, and deleted only while unused (0.5.10)",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const me = await api.me(token);
      const made = await api.createDocumentType(token, {
        label: '  Allotment   tenancy ',
        category: 'property',
        core: { expires: { shown: true }, identifier: { label: 'Plot number', required: true } },
        reminder_leads: [30, 60, 30],
      });
      expect(made.key).toMatch(/^h_[a-z2-7]{10}$/);
      expect(made).toMatchObject({
        label: 'Allotment tenancy',
        category: 'property',
        builtin: false,
        hidden: false,
        expiry_driver: 'expires_on',
        reminder_leads: [60, 30],
        default_visibility: 'household',
        fields: [],
        core: {
          identifier: { shown: true, required: true, label: 'Plot number' },
          expires: { shown: true },
        },
      });
      expect(typeof made.etag).toBe('string');
      expect((await api.documentTypes(token)).items.map((t) => t.key)).toContain(made.key);

      // Renamed, it keeps its key; its tag moves on, and the old one is refused.
      const renamed = await api.updateDocumentType(
        token,
        made.key,
        { label: 'Allotment lease' },
        made.etag,
      );
      expect(renamed).toMatchObject({ key: made.key, label: 'Allotment lease' });
      expect(renamed.etag).not.toBe(made.etag);
      const stale = await refusal(
        api.updateDocumentType(token, made.key, { label: 'Plot' }, made.etag),
      );
      expect(stale).toMatchObject({ status: 409, code: 'conflict' });
      // A built-in keeps its name.
      const builtin = await refusal(
        api.updateDocumentType(token, 'passport', { label: 'Travel document' }),
      );
      expect(builtin).toMatchObject({ status: 422, code: 'validation_failed' });

      // A field of the household's own, and the kind asking for it.
      const size = await api.createDocumentAttribute(token, {
        label: 'Plot size',
        kind: 'choice',
        choices: ['Half', 'Full', 'Half'],
      });
      expect(size.key).toMatch(/^h_[a-z2-7]{10}$/);
      expect(size).toMatchObject({ label: 'Plot size', kind: 'choice', builtin: false });
      expect(size.choices).toEqual(['Half', 'Full']);
      const asking = await api.updateDocumentType(token, made.key, {
        fields: [{ key: size.key, required: true }],
      });
      expect(asking.fields).toEqual([
        {
          key: size.key,
          label: 'Plot size',
          kind: 'choice',
          required: true,
          choices: ['Half', 'Full'],
        },
      ]);
      const notThere = await refusal(
        api.updateDocumentType(token, made.key, { fields: [{ key: 'no_such_field' }] }),
      );
      expect(notThere).toMatchObject({ status: 422, detail: 'no_such_field' });

      // Filed under it, it is in use: counted, archived, never deleted.
      const doc = await api.createDocument(token, {
        type_key: made.key,
        title: 'Plot 14',
        owner_member_id: me.member_id,
        identifier: 'P14',
        expires: { date: '2031-03-31', precision: 'day' },
        extra: { [size.key]: 'Half' },
      });
      expect(doc.status.value).toBe('active');
      const impact = await api.documentTypeImpact(token, made.key);
      expect(impact).toMatchObject({
        key: made.key,
        documents: 1,
        unseen: "Documents you can't see may also be affected.",
      });
      expect(impact.core.identifier).toEqual({ with_value: 1, without_value: 0 });
      expect(impact.core.expires).toEqual({ with_value: 1, without_value: 0 });
      expect(impact.fields).toEqual([
        { key: size.key, label: 'Plot size', with_value: 1, without_value: 0 },
      ]);
      const inUse = await refusal(api.deleteDocumentType(token, made.key));
      expect(inUse).toMatchObject({ status: 409, code: 'type_in_use' });
      expect((await api.archiveDocumentType(token, made.key)).hidden).toBe(true);
      // Its document keeps it, and the list keeps it while the document is there.
      expect((await api.document(token, doc.id)).type_key).toBe(made.key);
      expect((await api.documentTypes(token)).items.find((t) => t.key === made.key)?.hidden).toBe(
        true,
      );
      expect((await api.restoreDocumentType(token, made.key)).hidden).toBe(false);

      // One nothing is filed under is deleted, and gone for good.
      const spare = await api.createDocumentType(token, { label: 'Spare kind', category: 'other' });
      await api.deleteDocumentType(token, spare.key);
      const all = (await api.documentTypes(token, { all: true })).items.map((t) => t.key);
      expect(all).not.toContain(spare.key);
    },
  },
  {
    name: 'a kind of document as the vault keeps it: a conflict to reload from, names, Expires, what an edit touches (a field it dropped included), and a scan queued for a kind since deleted (0.5.10)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const me = await api.me(token);
      const gym = await api.createDocumentType(token, { label: 'Gym membership' });
      expect(gym).toMatchObject({
        expiry_driver: null,
        reminder_leads: [],
        core: { expires: { shown: false, required: false } },
      });

      // A stale tag is refused with the kind as it now is, to reload from.
      const renamed = await api.updateDocumentType(token, gym.key, { label: 'Gym pass' }, gym.etag);
      const stale = await refusal(
        api.updateDocumentType(token, gym.key, { label: 'Pool pass' }, gym.etag),
      );
      expect(stale).toMatchObject({ status: 409, code: 'conflict' });
      expect(JSON.parse(stale.detail as string)).toMatchObject({
        key: gym.key,
        label: 'Gym pass',
        etag: renamed.etag,
      });

      // Expires switched on with no lead times: reminded 30 days before, as
      // a new kind is, and its expiry required — as every kind that expires.
      const expiring = await api.updateDocumentType(token, gym.key, {
        core: { expires: { shown: true } },
      });
      expect(expiring).toMatchObject({
        expiry_driver: 'expires_on',
        reminder_leads: [30],
        core: { expires: { shown: true, required: true } },
      });
      const optional = await refusal(
        api.updateDocumentType(token, gym.key, { core: { expires: { required: false } } }),
      );
      expect(optional).toMatchObject({ status: 422, code: 'validation_failed', detail: 'expires' });
      const kinds = (await api.documentTypes(token, { all: true })).items;
      for (const t of kinds) {
        expect(t.core?.expires.required, t.key).toBe(t.expiry_driver !== null);
      }

      // The household's own is archived, never hidden; a name is 80 characters at most.
      const hidden = await refusal(api.createDocumentType(token, { label: 'Kept', hidden: true }));
      expect(hidden).toMatchObject({ status: 422, detail: 'hidden' });
      const long = 'A name far longer than any kind of document needs, '.repeat(2);
      for (const tooLong of [
        () => api.createDocumentType(token, { label: long }),
        () => api.updateDocumentType(token, gym.key, { short_label: long }),
        () => api.updateDocumentType(token, gym.key, { core: { identifier: { label: long } } }),
        () => api.createDocumentAttribute(token, { label: long, kind: 'text' }),
      ]) {
        const err = await refusal(tooLong());
        expect(err.status).toBe(422);
        expect(err.message).toMatch(/is too long: 80 characters at most\.$/);
      }

      // What a change would touch counts every fixed field a document has.
      await api.createDocument(token, {
        type_key: gym.key,
        title: 'Gym pass',
        owner_member_id: me.member_id,
        issued: { date: '2026-01-05', precision: 'day' },
        expires: { date: '2031-01-05', precision: 'day' },
        physical_location: 'Blue folder',
        tags: ['Fitness'],
      });
      const impact = await api.documentTypeImpact(token, gym.key);
      const one = { with_value: 1, without_value: 0 };
      expect(impact.core).toMatchObject({
        issued: one,
        expires: one,
        physical_location: one,
        tags: one,
        identifier: { with_value: 0, without_value: 1 },
      });

      // A field the kind no longer asks for is counted too, where one of its
      // documents keeps a value for it: shown again as required, that is
      // how many would need it (the 5.12 review). One none has, is not.
      const card = await api.createDocumentAttribute(token, { label: 'Member card', kind: 'text' });
      const locker = await api.createDocumentAttribute(token, { label: 'Locker', kind: 'text' });
      await api.updateDocumentType(token, gym.key, {
        fields: [{ key: card.key }, { key: locker.key }],
      });
      await api.createDocument(token, {
        type_key: gym.key,
        title: 'Old gym pass',
        owner_member_id: me.member_id,
        expires: { date: '2027-01-05', precision: 'day' },
        extra: { [card.key]: 'M-104' },
      });
      await api.updateDocumentType(token, gym.key, { fields: [] });
      const dropped = await api.documentTypeImpact(token, gym.key);
      expect(dropped.documents).toBe(2);
      expect(dropped.fields).toEqual([
        { key: card.key, label: null, with_value: 1, without_value: 1 },
      ]);

      // A scan queued offline against a kind deleted since is filed with no
      // kind, not refused for good; left unsaid, it is its filer's Only me.
      const plot = await api.createDocumentType(token, { label: 'Allotment plot' });
      await api.deleteDocumentType(token, plot.key);
      const made = await api.capture(
        token,
        {
          metadata: {
            type_key: plot.key,
            title: 'Plot 9',
            owner_member_id: me.member_id,
            identifier: 'P9',
          },
          file: { kind: 'bytes', filename: 'plot.pdf', contentType: 'application/pdf', bytes: PDF },
        },
        GONE_KIND_KEY,
      );
      expect(await api.document(token, made.document_id)).toMatchObject({
        type_key: null,
        title: 'Plot 9',
        owner_member_id: me.member_id,
        identifier: 'P9',
        visibility: 'private',
      });
    },
  },
  {
    name: "a phone files into a household's own kind with no details, which then says what it needs; its history says who added it (0.5.11)",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.custom_types).toBe(true);
      const kind = await api.createDocumentType(token, {
        label: 'Season ticket',
        category: 'bills',
        core: { identifier: { label: 'Ticket number', required: true } },
      });
      // An older phone groups its list by category: one of the twelve it knows.
      const listed = (await api.documentTypes(token)).items.find((t) => t.key === kind.key);
      expect(Object.keys(CATEGORY_LABELS)).toContain(listed?.category);
      // It files into the kind with no details at all, as app 0.2.0 does.
      const me = await api.me(token);
      const made = await api.capture(
        token,
        {
          metadata: { type_key: kind.key, owner_member_id: me.member_id },
          file: {
            kind: 'bytes',
            filename: 'ticket.pdf',
            contentType: 'application/pdf',
            bytes: PDF,
          },
        },
        OWN_KIND_KEY,
      );
      expect((await api.document(token, made.document_id)).status).toEqual({
        value: 'needs_info',
        label: 'Needs a ticket number',
      });
      // Who added the version, by the name the household knows them by.
      const mine = (await api.members(token)).items.find((m) => m.is_me);
      const history = (await api.versions(token, made.document_id)).items;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        id: made.version_id,
        document_id: made.document_id,
        version_no: 1,
        filename: 'ticket.pdf',
        uploaded_by_name: mine?.display_name,
      });
    },
  },
  {
    name: 'signing out ends the session',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      await api.logout(token);
      const err = await refusal(api.me(token));
      expect(isSessionOver(err)).toBe(true);
      // And says why (0.4.11), to the access token and the refresh token alike.
      expect(err.reason).toBe('revoked');
      const refused = await refusal(api.refresh((ctx.tokens as Tokens).refresh_token));
      expect(refused.reason).toBe('revoked');
    },
  },
];
