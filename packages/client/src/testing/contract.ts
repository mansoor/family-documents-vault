import {
  CATEGORY_LABELS,
  CORE_FIELDS,
  COLLECTION_HINT_TEENS,
  reminderOf,
  reminderSentence,
  shareEndWords,
  type CreatedUploadRequest,
  type DocumentTypeInput,
  type Role,
  type Tokens,
} from '@fdv/shared';
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
  /**
   * Makes the photos on their way (0.5.19), as the vault's worker does: the
   * real API's run stands in for the worker, which is not there; the fake
   * makes them itself at the next GET /members, and needs nothing here.
   */
  makePhotos?: () => Promise<void>;
  /**
   * Sends files through a request, as somebody outside the family would
   * (0.5.23), and gets them ready to be looked at, as the vault's worker
   * does: the real API's run drives the sender's page and stands in for the
   * worker (no scan, A42; one page drawn); the fake keeps them as sent.
   */
  sendFiles: (
    made: CreatedUploadRequest,
    files: Array<{ name: string; bytes: Uint8Array; contentType: string }>,
  ) => Promise<void>;
  /**
   * Somebody else with a sign-in of their own (5.28), who then signs in
   * with the email and password given: the real API's run invites them as
   * the owner of `token` (asked to confirm it is them first) and accepts
   * the invitation; the fake's puts them in `members` and `signIns`. Their
   * member id.
   */
  addSignIn: (
    token: string,
    who: { name: string; email: string; password: string; role: Role },
  ) => Promise<string>;
  /**
   * Two-step sign-in for the owner of `token`, just signed in, and a code
   * just given (5.28): what an owner power asks for (A54). The real API's
   * run turns on an authenticator and steps up with its code; the fake's
   * says its owners have it (`ownerTwoStep`). An owner never turns it off,
   * so a scenario asks it for an owner nothing after it signs in as.
   */
  ownerTwoStep: (token: string) => Promise<void>;
}

export interface Scenario {
  name: string;
  run: (api: Api, ctx: ContractContext) => Promise<void>;
}

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
/** A JPEG, as far as its first bytes say (0.5.19): the vault's worker makes the square. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);
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

const signIn = (api: Api, ctx: ContractContext): Promise<Tokens> =>
  signInAs(api, ctx.email, ctx.password);

/** Somebody signing in with a password alone: a session, not a second step. */
const signInAs = async (api: Api, email: string, password: string): Promise<Tokens> => {
  const t = await api.signIn(email, password);
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
    name: 'GET /document-types answers remind_from beside the old fields',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      // Kept since 0.5.15, and said on since the web's editor for it (0.5.16).
      expect((await api.capabilities()).features.reminder_dates).toBe(true);
      const { items } = await api.documentTypes(token, { all: true });
      for (const t of items) {
        expect(t, t.key).toHaveProperty('remind_from');
        expect(Array.isArray(t.remind_leads), t.key).toBe(true);
        // What an older phone reads is what the vault does: reminder_leads
        // is Expires's, and [] while a date field reminds.
        expect(t.reminder_leads, t.key).toEqual(
          t.remind_from && t.remind_from !== 'expires' ? [] : t.remind_leads,
        );
        if (t.remind_from === 'expires') expect(t.expiry_driver, t.key).not.toBeNull();
        if (t.remind_from === null || t.remind_from === 'expires') {
          expect(reminderOf(t), t.key).toEqual(
            reminderOf({ expiry_driver: t.expiry_driver, reminder_leads: t.reminder_leads }),
          );
        }
      }
      const type = (key: string) => items.find((t) => t.key === key);
      expect(type('passport')).toMatchObject({
        remind_from: 'expires',
        remind_leads: [270, 180],
        reminder_leads: [270, 180],
      });
      expect(type('bank_statement')).toMatchObject({ remind_from: null, reminder_leads: [] });
      // The date a bill can remind from, in every household's library.
      expect((await api.documentAttributes(token)).items).toContainEqual({
        key: 'due_date',
        label: 'Due date',
        kind: 'date',
        choices: null,
        builtin: true,
      });
    },
  },
  {
    name: 'a kind reminding from a date field keeps expiry_driver and reminder_leads as an older phone reads them',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const tax = await api.createDocumentType(token, {
        label: 'Council tax',
        category: 'bills',
        core: { expires: { shown: true } },
        fields: [{ key: 'due_date' }],
      });
      // Made showing Expires: reminded 30 days before it expires, as always.
      expect(tax).toMatchObject({
        expiry_driver: 'expires_on',
        reminder_leads: [30],
        remind_from: 'expires',
        remind_leads: [30],
      });
      const moved = await api.updateDocumentType(token, tax.key, { remind_from: 'due_date' });
      // Its Due date reminds, 7 days before; Expires is still asked for, and
      // an older phone reads it as Expires with no lead times — never "before
      // it expires" — and the due date as a date it requires.
      expect(moved).toMatchObject({
        remind_from: 'due_date',
        remind_leads: [7],
        expiry_driver: 'expires_on',
        reminder_leads: [],
        core: { expires: { shown: true, required: true } },
      });
      expect(moved.fields).toEqual([
        { key: 'due_date', label: 'Due date', kind: 'date', required: true },
      ]);
      expect(reminderSentence(moved)).toBeNull();
      expect(moved.etag).not.toBe(tax.etag);

      // Refused, each with its reason: no lead times; a date it does not ask
      // for; the reminding date made optional; both sets of lead times.
      const refusals: Array<[DocumentTypeInput, string]> = [
        [{ remind_from: 'due_date', remind_leads: [] }, 'remind_leads'],
        [{ remind_from: 'issued' }, 'remind_from'],
        [{ fields: [{ key: 'due_date', required: false }] }, 'due_date'],
        [{ remind_leads: [3], reminder_leads: [3] }, 'remind_leads'],
      ];
      for (const [change, detail] of refusals) {
        const refused = await refusal(api.updateDocumentType(token, tax.key, change));
        expect(refused, JSON.stringify(change)).toMatchObject({
          status: 422,
          code: 'validation_failed',
          detail,
        });
      }
      // The old lead times set the reminding date's.
      expect(
        await api.updateDocumentType(token, tax.key, { reminder_leads: [7, 1] }),
      ).toMatchObject({ remind_from: 'due_date', remind_leads: [7, 1], reminder_leads: [] });
      // Hiding the date it reminds from switches reminders off.
      expect(await api.updateDocumentType(token, tax.key, { fields: [] })).toMatchObject({
        remind_from: null,
        remind_leads: [],
        reminder_leads: [],
        expiry_driver: 'expires_on',
      });
      // A field named like one the library has, whatever its case, is refused.
      const twin = await refusal(
        api.createDocumentAttribute(token, { label: '  due   DATE ', kind: 'date' }),
      );
      expect(twin).toMatchObject({ status: 422, detail: 'label' });
      expect((await api.documentTypeImpact(token, tax.key)).reminders_by_source).toEqual({});
    },
  },
  {
    name: 'a collection holds what its maker puts in it, counted as they see it; a change is made to the collection they saw; a document says which collections it is in (0.5.12)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.collections).toBe(true);
      const me = await api.me(token);
      const everyday = await api.createDocument(token, {
        title: 'Contract council tax',
        owner_member_id: me.member_id,
      });
      const adults = await api.createDocument(token, {
        title: 'Contract mortgage offer',
        owner_member_id: me.member_id,
        visibility: 'adults',
      });
      const made = await api.createCollection(token, {
        name: '  For the   broker ',
        audience: 'everyone',
      });
      expect(made).toMatchObject({
        name: 'For the broker',
        description: null,
        audience: 'everyone',
        owner_member_id: me.member_id,
        mine: true,
        item_count: 0,
        items: [],
      });

      // Put in, in the order asked, each once; its maker is told who of its
      // audience cannot see one.
      const filled = await api.addToCollection(token, made.id, [
        everyday.id,
        adults.id,
        everyday.id,
      ]);
      expect(filled.items.map((i) => i.document.id)).toEqual([everyday.id, adults.id]);
      expect(filled.item_count).toBe(2);
      expect(filled.items.map((i) => i.hint)).toEqual([null, COLLECTION_HINT_TEENS]);
      // A document that is not there is refused, and nothing is put in with it.
      const missing = await refusal(api.addToCollection(token, made.id, [everyday.id, NEVER_USED]));
      expect(missing).toMatchObject({ status: 404, code: 'not_found' });
      expect((await api.getCollection(token, made.id)).item_count).toBe(2);
      expect(filled).toMatchObject({ has_more: false, next_cursor: null });

      // A page at a time: item_count is all of them, on every page.
      const first = await api.getCollection(token, made.id, { limit: 1 });
      expect(first.items.map((i) => i.document.id)).toEqual([everyday.id]);
      expect(first).toMatchObject({ item_count: 2, has_more: true });
      expect(typeof first.next_cursor).toBe('string');
      const second = await api.getCollection(token, made.id, {
        limit: 1,
        cursor: first.next_cursor,
      });
      expect(second.items.map((i) => i.document.id)).toEqual([adults.id]);
      expect(second).toMatchObject({ item_count: 2, has_more: false, next_cursor: null });
      const badCursor = await refusal(
        api.getCollection(token, made.id, { cursor: 'not-a-cursor' }),
      );
      expect(badCursor).toMatchObject({ status: 422, code: 'validation_failed' });

      // The same count in the list of collections; each document says it is in it.
      const listed = (await api.collections(token)).items.find((l) => l.id === made.id);
      expect(listed).toMatchObject({ name: 'For the broker', item_count: 2, mine: true });
      expect((await api.documentCollections(token, adults.id)).items.map((l) => l.id)).toEqual([
        made.id,
      ]);

      // Renamed, made to the collection as it was seen: an older ETag is refused.
      const renamed = await api.updateCollection(
        token,
        made.id,
        { name: 'For the new broker' },
        made.etag,
      );
      expect(renamed).toMatchObject({ name: 'For the new broker', item_count: 2 });
      expect(renamed.etag).not.toBe(made.etag);
      const stale = await refusal(
        api.updateCollection(token, made.id, { audience: 'adults' }, made.etag),
      );
      expect(stale).toMatchObject({ status: 409, code: 'conflict' });
      // A collection has a name, of 80 characters at most, and somebody it is for.
      for (const name of ['   ', 'x'.repeat(81)]) {
        const err = await refusal(api.createCollection(token, { name, audience: 'everyone' }));
        expect(err).toMatchObject({ status: 422, code: 'validation_failed', detail: 'name' });
      }

      // Taken out, once; a second time it is not in it.
      await api.removeFromCollection(token, made.id, adults.id);
      expect((await api.getCollection(token, made.id)).items.map((i) => i.document.id)).toEqual([
        everyday.id,
      ]);
      const twice = await refusal(api.removeFromCollection(token, made.id, adults.id));
      expect(twice).toMatchObject({ status: 404, code: 'not_found' });

      // Deleted, it is gone; its documents are not.
      await api.deleteCollection(token, made.id);
      const gone = await refusal(api.getCollection(token, made.id));
      expect(gone).toMatchObject({ status: 404, code: 'not_found' });
      expect((await api.collections(token)).items.map((l) => l.id)).not.toContain(made.id);
      expect((await api.documentCollections(token, everyday.id)).items).toEqual([]);
      expect((await api.document(token, everyday.id)).title).toBe('Contract council tax');
    },
  },
  {
    name: "a person's photo: PUT answers 202 processing, members then carry photo, DELETE clears it",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.member_photos).toBe(true);
      const me = await api.me(token);
      const mine = async () => (await api.members(token)).items.find((m) => m.id === me.member_id);
      expect(await mine()).toMatchObject({
        photo: null,
        photo_status: null,
        can_change_photo: true,
      });

      const sent = await api.setMemberPhoto(token, me.member_id, {
        file: { kind: 'bytes', filename: 'me.jpg', contentType: 'image/jpeg', bytes: JPEG },
        crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
      });
      expect(sent).toMatchObject({ id: me.member_id, photo: null, photo_status: 'processing' });
      // Not a photo: refused, as what it is, and what was on its way stays.
      const pdf = await refusal(
        api.setMemberPhoto(token, me.member_id, {
          file: { kind: 'bytes', filename: 'me.pdf', contentType: 'application/pdf', bytes: PDF },
        }),
      );
      expect(pdf).toMatchObject({ status: 415, code: 'unsupported_type' });
      // The crop after the photo: refused.
      const late = multipartBody([
        { name: 'file', filename: 'me.jpg', contentType: 'image/jpeg', bytes: JPEG },
        { name: 'crop', value: JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }) },
      ]);
      const order = await refusal(
        api.http.request(`/api/v1/members/${me.member_id}/photo`, {
          method: 'PUT',
          upload: { kind: 'bytes', bytes: late.bytes, contentType: late.contentType },
          token,
        }),
      );
      expect(order).toMatchObject({ status: 422, code: 'validation_failed' });

      await ctx.makePhotos?.();
      const made = await mine();
      expect(typeof made?.photo?.id).toBe('string');
      expect(made?.photo_status).toBeNull();
      const photoId = (made?.photo as { id: string }).id;
      const res = await api.memberPhoto(token, me.member_id, photoId);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(api.memberPhotoUrl(me.member_id, photoId)).toMatch(
        new RegExp(`/api/v1/members/${me.member_id}/photo/${photoId}$`),
      );

      await api.removeMemberPhoto(token, me.member_id);
      expect(await mine()).toMatchObject({ photo: null, photo_status: null });
      const gone = await refusal(api.memberPhoto(token, me.member_id, photoId));
      expect(gone).toMatchObject({ status: 404, code: 'no_photo' });
      // Nothing there to take away is not a refusal.
      await api.removeMemberPhoto(token, me.member_id);
    },
  },
  {
    name: 'an owner removes their own document from the Trash for good, and it is gone (5.24)',
    run: async (api, ctx) => {
      // Signed in afresh: removing for good asks to confirm it's you, and a
      // sign-in is that, for five minutes.
      const { access_token: token } = await signIn(api, ctx);
      const made = await api.createDocument(token, { title: 'A mistaken upload' });
      // Only from the Trash.
      const early = await refusal(api.purgeDocument(token, made.id));
      expect(early).toMatchObject({ status: 409, code: 'not_in_trash' });
      expect((await api.document(token, made.id)).id).toBe(made.id);

      await api.deleteDocument(token, made.id);
      const trash = await api.documents(token, { deleted: 'true' });
      const binned = trash.items.find((d) => d.id === made.id);
      // Nobody has asked: it is the owner's own, and goes at once.
      expect(binned).toMatchObject({
        purge_requested_at: null,
        purge_allowed_from: null,
        purge_at_once: true,
      });
      expect(await api.purgeDocument(token, made.id)).toEqual({ removed: true });

      const gone = await refusal(api.document(token, made.id));
      expect(gone.status).toBe(404);
      const after = await api.documents(token, { deleted: 'true' });
      expect(after.items.map((d) => d.id)).not.toContain(made.id);
      // Gone is gone: asked again, there is nothing to remove.
      const again = await refusal(api.purgeDocument(token, made.id));
      expect(again).toMatchObject({ status: 404, code: 'not_found' });
    },
  },
  {
    name: "a person's details are changed as they were seen: an older version is 409 with them as they are now; an owner with only a password is refused the view of a sign-in (5.25)",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.member_edit).toBe(true);
      const me = await api.me(token);
      const mine = async () => (await api.members(token)).items.find((m) => m.id === me.member_id);
      const before = await mine();
      expect(before?.can_edit).toBe(true);
      expect(typeof before?.version).toBe('number');
      const version = before?.version as number;

      const changed = await api.updateMember(token, me.member_id, { relationship: 'Dad' }, version);
      expect(changed).toMatchObject({
        id: me.member_id,
        relationship: 'Dad',
        version: version + 1,
      });
      // Made to the version read before that change: refused, with the person
      // as they are now, and nothing changed.
      const stale = await refusal(
        api.updateMember(token, me.member_id, { relationship: 'Father' }, version),
      );
      expect(stale).toMatchObject({ status: 409, code: 'conflict' });
      expect(JSON.parse(stale.detail ?? '{}')).toMatchObject({
        id: me.member_id,
        relationship: 'Dad',
        version: version + 1,
      });
      expect((await mine())?.relationship).toBe('Dad');
      // Nothing different sent: no new version.
      expect(
        (await api.updateMember(token, me.member_id, { relationship: 'Dad' }, version + 1)).version,
      ).toBe(version + 1);
      // Somebody who can still sign in is not recorded as passed away.
      const signedIn = await refusal(
        api.updateMember(token, me.member_id, { is_deceased: true }, version + 1),
      );
      expect(signedIn).toMatchObject({ status: 409, code: 'signed_in' });
      const back = await api.updateMember(token, me.member_id, { relationship: null }, version + 1);
      expect(back).toMatchObject({ relationship: null, version: version + 2, is_deceased: false });

      // This owner signs in with a password alone: their view of anybody's
      // sign-in, their own included, is refused until they have two-step
      // sign-in or a passkey (A54).
      const card = await refusal(api.memberAccount(token, me.member_id));
      expect(card).toMatchObject({ status: 403, code: 'totp_required_for_owner' });
    },
  },
  {
    name: 'files sent through a request wait to be looked at, then are filed or refused, once (0.5.23)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.upload_requests).toBe(true);
      const made = await api.createUploadRequest(token, {
        title: 'Contract tax papers',
        recipient_label: 'Jane, accountant',
        review_by: 'adults',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      });
      const w2 = new TextEncoder().encode('%PDF-1.4\n% the W-2\n%%EOF\n');
      const spam = new TextEncoder().encode('%PDF-1.4\n% not asked for\n%%EOF\n');
      await ctx.sendFiles(made, [
        { name: 'W-2 2025.pdf', bytes: w2, contentType: 'application/pdf' },
        { name: 'spam.pdf', bytes: spam, contentType: 'application/pdf' },
      ]);
      const waiting = (await api.incoming(token)).items;
      const first = waiting.find((f) => f.name === 'W-2 2025.pdf');
      const second = waiting.find((f) => f.name === 'spam.pdf');
      expect(first).toMatchObject({
        request_id: made.request.id,
        request_title: 'Contract tax papers',
        recipient_label: 'Jane, accountant',
        content_type: 'application/pdf',
        byte_size: w2.length,
        scan_state: 'unscanned',
        preview_state: 'ready',
        preview_pages: 1,
        review_by: 'adults',
        moved_to_owners: false,
      });
      const id = (first as { id: string }).id;
      const other = (second as { id: string }).id;

      // A look: its page, and a copy under the name its bytes say, unscanned.
      const page = await api.incomingPage(token, id, 1);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('image/jpeg');
      const copy = await api.incomingContent(token, id);
      expect(new Uint8Array(await copy.arrayBuffer())).toEqual(w2);
      expect(copy.headers.get('content-disposition')).toBe(
        "attachment; filename*=UTF-8''W-2%202025.pdf",
      );
      expect(copy.headers.get('x-content-type-options')).toBe('nosniff');
      expect(copy.headers.get('x-fdv-scan')).toBe('unscanned');

      // Filed into a document that is not there: not there.
      const missing = await refusal(
        api.acceptIncoming(token, id, { into_document_id: NEVER_USED }),
      );
      expect(missing).toMatchObject({ status: 404, code: 'not_found' });
      // As a kind the household does not have: refused, saying which detail
      // (not filed with no kind, as a phone's queued capture is).
      const kindless = await refusal(
        api.acceptIncoming(token, id, { title: 'Contract W-2', type_key: 'no_such_kind' }),
      );
      expect(kindless).toMatchObject({
        status: 422,
        code: 'validation_failed',
        message: 'That kind of document is not on the list.',
        detail: 'type_key',
      });
      expect((await api.incoming(token)).items.map((f) => f.id)).toContain(id);
      // Filed as a new document; the other refused.
      const filed = await api.acceptIncoming(token, id, { title: 'Contract W-2' });
      expect((await api.document(token, filed.document_id)).title).toBe('Contract W-2');
      const versions = (await api.versions(token, filed.document_id)).items;
      expect(versions.map((v) => v.id)).toEqual([filed.version_id]);
      await api.rejectIncoming(token, other);
      const left = (await api.incoming(token)).items.map((f) => f.id);
      expect(left).not.toContain(id);
      expect(left).not.toContain(other);
      // Decided is decided, whichever way.
      for (const again of [
        refusal(api.rejectIncoming(token, id)),
        refusal(api.acceptIncoming(token, other, { title: 'Second thoughts' })),
      ]) {
        expect(await again).toMatchObject({ status: 409, code: 'already_decided' });
      }
    },
  },
  {
    name: "a person's identity details: masked until shown, each part with a version of its own, a stale one 409; who sees them is an owner's with two-step sign-in (5.26)",
    run: async (api, ctx) => {
      expect((await api.capabilities()).features.member_identity).toBe(true);
      // Just signed in: showing one's own numbers asks nothing more.
      const token = (await signIn(api, ctx)).access_token;
      const me = await api.me(token);
      expect(await api.identity(token, me.member_id)).toMatchObject({
        member_id: me.member_id,
        audience: 'owners_and_self',
        can_edit: { shared: true, only_me: true },
        versions: { shared: 0, only_me: 0 },
        shared: { fields: {}, masked: [], version: 0 },
        only_me: { fields: {}, version: 0 },
      });
      const made = await api.updateIdentity(token, me.member_id, {
        part: 'shared',
        version: 0,
        fields: { given_name: 'Contract', ids: [{ id: 'p1', kind: 'passport', number: 'C-123' }] },
      });
      expect(made.versions).toEqual({ shared: 1, only_me: 0 });
      expect(made.shared.masked).toEqual(['ids.p1']);
      // Masked: left out, so that a form sending back what it was shown keeps it.
      expect(made.shared.fields.ids?.[0]).not.toHaveProperty('number');
      expect(made.shared.filled).toEqual(['given_name', 'ids.p1']);
      // Made from a version that has moved on: refused, and nothing changed.
      const stale = await refusal(
        api.updateIdentity(token, me.member_id, { part: 'shared', version: 0, fields: {} }),
      );
      expect(stale).toMatchObject({ status: 409, code: 'conflict' });
      // A masked value left out is kept.
      const kept = await api.updateIdentity(token, me.member_id, {
        part: 'shared',
        version: 1,
        fields: { given_name: 'Contract', ids: [{ id: 'p1', kind: 'passport' }] },
      });
      expect(kept.versions.shared).toBe(1);
      const renamed = await api.updateIdentity(token, me.member_id, {
        part: 'shared',
        version: 1,
        fields: { given_name: 'Contracted', ids: [{ id: 'p1', kind: 'passport' }] },
      });
      expect(renamed.versions.shared).toBe(2);
      expect(
        (await api.revealIdentity(token, me.member_id, { keys: ['ids.p1', 'given_name'] })).values,
      ).toEqual({ 'ids.p1': 'C-123' });
      // What a GET gives, sent back as it is: nothing changes, nothing is lost.
      const shown = await api.identity(token, me.member_id);
      const echoed = await api.updateIdentity(token, me.member_id, {
        part: 'shared',
        version: shown.versions.shared,
        fields: shown.shared.fields,
      });
      expect(echoed.versions.shared).toBe(2);
      expect(echoed.shared.masked).toEqual(['ids.p1']);
      expect((await api.revealIdentity(token, me.member_id, { keys: ['ids.p1'] })).values).toEqual({
        'ids.p1': 'C-123',
      });
      // A hidden field written back unhidden, its value left out, stays
      // hidden: unhiding it takes the value itself.
      const hid = await api.updateIdentity(token, me.member_id, {
        part: 'shared',
        version: 2,
        fields: {
          ...shown.shared.fields,
          custom: [{ id: 'k1', label: 'PIN', value: '4471', hidden: true }],
        },
      });
      expect(hid.shared.masked).toEqual(['ids.p1', 'custom.k1']);
      const unhid = await api.updateIdentity(token, me.member_id, {
        part: 'shared',
        version: hid.versions.shared,
        fields: { ...hid.shared.fields, custom: [{ id: 'k1', label: 'PIN', hidden: false }] },
      });
      expect(unhid.versions.shared).toBe(hid.versions.shared);
      expect(unhid.shared.fields.custom).toEqual([{ id: 'k1', label: 'PIN', hidden: true }]);
      // A part too big to keep is refused as too long.
      const tooLong = await refusal(
        api.updateIdentity(token, me.member_id, {
          part: 'only_me',
          version: 0,
          fields: {
            custom: Array.from({ length: 40 }, (_, i) => ({
              id: `c${i}`,
              label: 'x',
              value: 'ب'.repeat(2000),
            })),
          },
        }),
      );
      expect(tooLong).toMatchObject({ status: 422, code: 'validation_failed' });
      // The Only me part moves its own version, and nothing else.
      const mine = await api.updateIdentity(token, me.member_id, {
        part: 'only_me',
        version: 0,
        fields: { notes: 'mine alone' },
      });
      expect(mine.versions).toEqual({ shared: hid.versions.shared, only_me: 1 });
      expect(mine.only_me?.fields.notes).toBe('mine alone');
      // Nobody at all: nothing there.
      const nobody = await refusal(api.identity(token, '00000000-0000-4000-8000-000000000000'));
      expect(nobody).toMatchObject({ status: 404, code: 'not_found' });
      // Who sees them: this owner signs in with a password alone, and is
      // refused the switch until they have two-step sign-in or a passkey (A54).
      expect(await api.identityAudience(token)).toMatchObject({
        audience: 'owners_and_self',
        pending: null,
        can_change: true,
      });
      const refused = await refusal(api.setIdentityAudience(token, 'adults'));
      expect(refused).toMatchObject({
        status: 403,
        code: 'totp_required_for_owner',
        message: 'Turn on two-step sign-in to change who can see identity details.',
      });
      expect((await api.identityAudience(token)).pending).toBeNull();
    },
  },
  {
    name: "an owner locks an adult's sign-in until a time, with a note: the card says so, her session ends (suspended), her right password is refused (403 membership_suspended), and an unlock lets her in again; never an owner's, never by anybody else (5.28)",
    run: async (api, ctx) => {
      expect((await api.capabilities()).features.member_admin).toBe(true);
      const first = await signIn(api, ctx);
      const me = await api.me(first.access_token);
      const firstName = (await api.members(first.access_token)).items.find(
        (m) => m.id === me.member_id,
      )?.display_name;
      const sara = { email: 'locked-adult@example.test', password: 'the adult’s own password' };
      const saraId = await ctx.addSignIn(first.access_token, {
        name: 'Sara',
        role: 'adult',
        ...sara,
      });
      // Another owner, who locks: the scenarios' own owner keeps signing in
      // with a password alone.
      const second = {
        email: 'second-owner@example.test',
        password: 'the second owner’s password',
      };
      await ctx.addSignIn(first.access_token, { name: 'Second Owner', role: 'owner', ...second });

      // Who may, first: never anybody but an owner, whatever they send.
      const theirs = await signInAs(api, sara.email, sara.password);
      expect(theirs).toMatchObject({ member_id: saraId, role: 'adult' });
      const notAnOwner = {
        status: 403,
        code: 'forbidden',
        message: "Only an owner can lock or unlock someone's sign-in.",
      };
      expect(
        await refusal(api.lockMember(theirs.access_token, me.member_id, { bogus: 1 } as never)),
      ).toMatchObject(notAnOwner);
      expect(await refusal(api.unlockMember(theirs.access_token, me.member_id))).toMatchObject(
        notAnOwner,
      );
      expect(await refusal(api.resumeMember(theirs.access_token, saraId))).toMatchObject({
        status: 403,
        code: 'forbidden',
      });
      // Then what was sent, then the owner power (A54): an owner with only a
      // password is refused it.
      expect(
        await refusal(api.lockMember(first.access_token, saraId, { bogus: 1 } as never)),
      ).toMatchObject({ status: 422, code: 'validation_failed' });
      expect(await refusal(api.lockMember(first.access_token, saraId))).toMatchObject({
        status: 403,
        code: 'totp_required_for_owner',
        message: "Turn on two-step sign-in to manage other people's sign-ins.",
      });

      // The other owner, with two-step sign-in and a code just given.
      const owner = await signInAs(api, second.email, second.password);
      await ctx.ownerTwoStep(owner.access_token);
      const token = owner.access_token;
      // Nobody; oneself; another owner (A50).
      expect(
        await refusal(api.lockMember(token, '00000000-0000-4000-8000-000000000000')),
      ).toMatchObject({ status: 404, code: 'not_found', message: 'They have no sign-in to lock.' });
      expect(await refusal(api.lockMember(token, owner.member_id))).toMatchObject({
        status: 422,
        code: 'validation_failed',
        message: 'You cannot lock your own sign-in.',
      });
      expect(await refusal(api.lockMember(token, me.member_id))).toMatchObject({
        status: 409,
        code: 'owner_notice_required',
        message: `${firstName} is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
      });
      // An end without its seconds is not one the vault reads (the 5.28 review).
      expect(
        await refusal(api.lockMember(token, saraId, { until: '2030-01-01T07:00Z' })),
      ).toMatchObject({ status: 422, code: 'validation_failed' });
      // An end that is not in the future, or more than a year off.
      const at = (ms: number) => new Date(Date.now() + ms).toISOString();
      expect(await refusal(api.lockMember(token, saraId, { until: at(-60_000) }))).toMatchObject({
        status: 422,
        code: 'validation_failed',
        message: 'Choose a time in the future to unlock.',
      });
      expect(
        await refusal(api.lockMember(token, saraId, { until: at(366 * 86_400_000) })),
      ).toMatchObject({
        status: 422,
        code: 'validation_failed',
        message:
          'A lock can end by itself within a year at most. Leave the end out to keep it until you unlock it.',
      });

      // A wider audience for identity details, waiting its notice...
      expect((await api.setIdentityAudience(token, 'adults')).pending?.to).toBe('adults');
      // Locked until a whole minute two days off, with a note for the owners.
      const until = new Date(
        Math.ceil((Date.now() + 2 * 86_400_000) / 60_000) * 60_000,
      ).toISOString();
      const locked = await api.lockMember(token, saraId, { until, note: '  Lost her phone.  ' });
      expect(locked).toEqual({
        member_id: saraId,
        suspension: {
          reason: 'locked',
          since: expect.any(String) as unknown,
          until,
          note: 'Lost her phone.',
          by: 'Second Owner',
        },
      });
      // ...is withdrawn, as she could neither be told nor mark anything Only
      // me; and none is asked for while she cannot sign in.
      expect((await api.identityAudience(token)).pending).toBeNull();
      expect(await refusal(api.setIdentityAudience(token, 'adults'))).toMatchObject({
        status: 409,
        code: 'member_cannot_be_told',
        message:
          'Sara cannot sign in just now, so could not be told, or mark anything Only me first. Let more people see identity details once everybody can sign in.',
      });
      // Locked already; and a lock is unlocked, not turned back on.
      expect(await refusal(api.lockMember(token, saraId))).toMatchObject({
        status: 409,
        code: 'already_locked',
        message: "Sara's sign-in is locked already. Unlock it first to lock it differently.",
      });
      expect(await refusal(api.resumeMember(token, saraId))).toMatchObject({
        status: 409,
        code: 'not_paused',
        message: "Sara's sign-in is not waiting after a restore.",
      });
      // The card says so, and how long a phone shows what it keeps.
      const card = await api.memberAccount(token, saraId);
      expect(card.suspension).toEqual(locked.suspension);
      expect(card.max_offline_days).toBe(90);
      // A lock is not a restore's: nobody waits there.
      expect((await api.afterRestore(token)).sign_ins).toEqual([]);

      // Her session is over, and says why, to its access and refresh tokens alike.
      const over = await refusal(api.me(theirs.access_token));
      expect(over).toMatchObject({ status: 401, code: 'session_ended', reason: 'suspended' });
      expect(isSessionOver(over)).toBe(true);
      expect(await refusal(api.refresh(theirs.refresh_token))).toMatchObject({
        status: 401,
        code: 'session_ended',
        reason: 'suspended',
      });
      // A wrong password is told nothing of the lock; the right one, once
      // proven, is refused, saying until when — and is no session's end.
      expect(await refusal(api.signIn(sara.email, 'not her password at all'))).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
      });
      const refused = await refusal(api.signIn(sara.email, sara.password));
      expect(refused).toMatchObject({
        status: 403,
        code: 'membership_suspended',
        reason: 'locked',
        message: `An owner has locked your sign-in until ${shareEndWords(new Date(until), 'UTC')} (UTC). Ask one of them if you need to get in sooner.`,
      });
      expect(isSessionOver(refused)).toBe(false);

      // Unlocked: the card says nothing more, and she signs in as before.
      await api.unlockMember(token, saraId);
      expect((await api.memberAccount(token, saraId)).suspension).toBeNull();
      expect(await refusal(api.unlockMember(token, saraId))).toMatchObject({
        status: 409,
        code: 'not_locked',
        message: "Sara's sign-in is not locked.",
      });
      const back = await signInAs(api, sara.email, sara.password);
      expect((await api.me(back.access_token)).member_id).toBe(saraId);
      // The session the lock ended stays ended.
      expect(await refusal(api.refresh(theirs.refresh_token))).toMatchObject({
        reason: 'suspended',
      });
    },
  },
  {
    name: "an owner starts a password reset for an adult: by the operator's mail server the answer holds no link, and the card says which way beforehand; stop_now ends her session and her password; never by anybody but an owner, never for oneself, another owner or anybody locked (5.29)",
    run: async (api, ctx) => {
      const first = await signIn(api, ctx);
      const me = await api.me(first.access_token);
      // Nobody made a link to hand over for her own sign-in.
      expect(me.reset_notice ?? null).toBeNull();
      const firstName = (await api.members(first.access_token)).items.find(
        (m) => m.id === me.member_id,
      )?.display_name;
      const rana = { email: 'reset-adult@example.test', password: 'the adult’s own password' };
      const ranaId = await ctx.addSignIn(first.access_token, {
        name: 'Rana',
        role: 'adult',
        ...rana,
      });
      const second = {
        email: 'reset-second-owner@example.test',
        password: 'the other owner’s password',
      };
      await ctx.addSignIn(first.access_token, { name: 'Other Owner', role: 'owner', ...second });

      // Who may, first: never anybody but an owner, whatever they send.
      const theirs = await signInAs(api, rana.email, rana.password);
      expect(
        await refusal(
          api.startPasswordReset(theirs.access_token, me.member_id, { bogus: 1 } as never),
        ),
      ).toMatchObject({
        status: 403,
        code: 'forbidden',
        message: "Only an owner can start a reset of someone's password.",
      });
      // Then what was sent, before the owner power (A54) is asked. (A
      // password-only owner's refusal is the lock's, above: the fake's
      // owners have two-step sign-in from then on. The API's own tests walk
      // it for a reset.)
      expect(
        await refusal(api.startPasswordReset(first.access_token, ranaId, { bogus: 1 } as never)),
      ).toMatchObject({ status: 422, code: 'validation_failed' });

      const owner = await signInAs(api, second.email, second.password);
      await ctx.ownerTwoStep(owner.access_token);
      const token = owner.access_token;
      // Nobody; oneself; another owner (A50).
      expect(
        await refusal(api.startPasswordReset(token, '00000000-0000-4000-8000-000000000000')),
      ).toMatchObject({
        status: 404,
        code: 'not_found',
        message: 'They have no sign-in to reset.',
      });
      expect(await refusal(api.startPasswordReset(token, owner.member_id))).toMatchObject({
        status: 422,
        code: 'validation_failed',
      });
      expect(await refusal(api.startPasswordReset(token, me.member_id))).toMatchObject({
        status: 409,
        code: 'owner_notice_required',
        message: `${firstName} is an owner, and one owner's password is never reset by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
      });

      // The card says which way beforehand: by the operator's mail server.
      expect((await api.memberAccount(token, ranaId)).reset_path).toBe('mail');
      const sent = await api.startPasswordReset(token, ranaId);
      expect(sent).toEqual({
        member_id: ranaId,
        path: 'mail',
        stop_now: false,
        expires_at: expect.any(String) as unknown,
      });
      const hour = new Date(sent.expires_at as string).getTime() - Date.now();
      expect(hour).toBeGreaterThan(55 * 60_000);
      expect(hour).toBeLessThanOrEqual(60 * 60_000);
      // Until she uses it, her session goes on and her password works.
      expect((await api.me(theirs.access_token)).member_id).toBe(ranaId);
      expect((await signInAs(api, rana.email, rana.password)).member_id).toBe(ranaId);

      // Her password stops now (A48): her session ends, and the old
      // password is refused as any wrong one is.
      expect(await api.startPasswordReset(token, ranaId, { stop_now: true })).toMatchObject({
        member_id: ranaId,
        path: 'mail',
        stop_now: true,
      });
      const over = await refusal(api.me(theirs.access_token));
      expect(over).toMatchObject({ status: 401, code: 'session_ended', reason: 'revoked' });
      expect(isSessionOver(over)).toBe(true);
      expect(await refusal(api.signIn(rana.email, rana.password))).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
      });

      // Locked: no reset, and the card says none.
      await api.lockMember(token, ranaId);
      expect((await api.memberAccount(token, ranaId)).reset_path).toBeNull();
      expect(await refusal(api.startPasswordReset(token, ranaId))).toMatchObject({
        status: 409,
        code: 'locked',
        message: "Rana's sign-in is locked. Unlock it first, then reset their password.",
      });
      await api.unlockMember(token, ranaId);
      expect((await api.memberAccount(token, ranaId)).reset_path).toBe('mail');

      // Nothing to have seen is as good as having seen it.
      await api.dismissResetNotice(first.access_token);
      expect((await api.me(first.access_token)).reset_notice ?? null).toBeNull();
    },
  },
  {
    name: 'an owner signs an adult out everywhere: each of her sessions ends (revoked), she signs in again as before; nobody else may, and nobody is 404 (5.30)',
    run: async (api, ctx) => {
      expect((await api.capabilities()).features.sign_out_everywhere).toBe(true);
      const first = await signIn(api, ctx);
      const tess = { email: 'signed-out-adult@example.test', password: 'the adult’s own password' };
      const tessId = await ctx.addSignIn(first.access_token, {
        name: 'Tess',
        role: 'adult',
        ...tess,
      });
      const third = { email: 'third-owner@example.test', password: 'the third owner’s password' };
      await ctx.addSignIn(first.access_token, { name: 'Third Owner', role: 'owner', ...third });
      const phone = await signInAs(api, tess.email, tess.password);
      const laptop = await signInAs(api, tess.email, tess.password);

      // Who may: never anybody but an owner — not an adult, of anybody.
      expect(
        await refusal(api.signOutEverywhere(phone.access_token, first.member_id)),
      ).toMatchObject({
        status: 403,
        code: 'forbidden',
        message: 'Only an owner can sign someone out everywhere.',
      });

      // An owner with two-step sign-in and a code just given (A54).
      const owner = await signInAs(api, third.email, third.password);
      await ctx.ownerTwoStep(owner.access_token);
      expect(
        await refusal(
          api.signOutEverywhere(owner.access_token, '00000000-0000-4000-8000-000000000000'),
        ),
      ).toMatchObject({
        status: 404,
        code: 'not_found',
        message: 'They have no sign-in to sign out.',
      });
      // Both of these, and any other she has: the vault's own count.
      const out = await api.signOutEverywhere(owner.access_token, tessId);
      expect(out.member_id).toBe(tessId);
      expect(out.sessions_ended).toBeGreaterThanOrEqual(2);
      // Both of her sessions are over, and say they were signed out.
      for (const t of [phone, laptop]) {
        const over = await refusal(api.me(t.access_token));
        expect(over).toMatchObject({ status: 401, code: 'session_ended', reason: 'revoked' });
        expect(isSessionOver(over)).toBe(true);
        expect(await refusal(api.refresh(t.refresh_token))).toMatchObject({ reason: 'revoked' });
      }
      // Her sign-in is as it was: she signs in again with her own password.
      const back = await signInAs(api, tess.email, tess.password);
      expect((await api.me(back.access_token)).member_id).toBe(tessId);
    },
  },
  {
    name: 'a refresh token spent twice by a thief before the owner refreshes ends the session as reused when the owner’s comes in, and the thief’s with it (5.30)',
    run: async (api, ctx) => {
      const stolen = await signIn(api, ctx);
      const thief1 = await api.refresh(stolen.refresh_token);
      const thief2 = await api.refresh(thief1.refresh_token);
      // The owner's copy of the first token, two refreshes behind.
      expect(await refusal(api.refresh(stolen.refresh_token))).toMatchObject({
        status: 401,
        code: 'session_ended',
        reason: 'reused',
      });
      expect(await refusal(api.refresh(thief2.refresh_token))).toMatchObject({ reason: 'reused' });
      expect(await refusal(api.me(thief2.access_token))).toMatchObject({ reason: 'reused' });
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
