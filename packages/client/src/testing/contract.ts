import {
  ACTIVITY_CSV_COLUMNS,
  activityCsvCapped,
  APP_BASIC_DEPRECATION,
  APP_KEYS_MAX,
  CATEGORY_LABELS,
  CORE_FIELDS,
  COLLECTION_HINT_TEENS,
  FOLDERS_CABINET,
  localToday,
  PASSWORD_RULES_DEFAULT,
  onlyEveryone,
  reminderOf,
  reminderSentence,
  SESSION_LOCKED_CODE,
  shareEndWords,
  type BatchReadFailure,
  type CabinetLevel,
  type CreatedUploadRequest,
  type DetailProposal,
  type PaperReading,
  type DocumentTypeInput,
  type AppAccessToken,
  type AppMe,
  type AppScope,
  type Role,
  type Tokens,
  type DocumentListParams,
} from '@fdv/shared';
import { expect } from 'vitest';
import { deviceHeaders, type Api } from '../api.js';
import {
  basicAuthorization,
  createAppClient,
  parseConnectionString,
  type AppClient,
} from '../apps.js';
import type { FetchLike, RequestInitLike, ResponseLike } from '../http.js';
import { ApiRequestError, isSessionLocked, isSessionOver } from '../errors.js';
import { multipartBody } from '../multipart.js';
import { negotiate } from '../negotiate.js';
import { zipEntryNames } from './zip.js';

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
  /** The setup code the vault takes (0.9.0): the real API's harness has one; the fake takes any. */
  setupToken?: string;
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
  /**
   * A guest's sign-in, ended a minute ago (5.34): the real API's run writes
   * it as the owning role (nobody signed in may set an end in the past);
   * the fake's moves its guest's end. Optional: a context from before 5.34
   * has none, and its scenarios never ask.
   */
  endGuestAccess?: (memberId: string) => Promise<void>;
  /**
   * A batch's items read, as the vault's worker reads them (Phase 6, I2):
   * the real API's run seals each one's words and what they propose under
   * the item's own key, as the worker does; the fake's keeps them on the
   * item. Optional: a context from before I2 has none, and its scenarios
   * never ask. With `paper`, the page's shape sealed beside the proposal too,
   * as the worker seals it since 0.9.0 (R1).
   */
  readBatchItems?: (
    batchId: string,
    reads: Record<
      string,
      { proposal: DetailProposal; paper?: PaperReading } | { failure: BatchReadFailure }
    >,
  ) => Promise<void>;
  /**
   * Somebody's 13th birthday, today, as the vault's worker sees it (after
   * 0.7.0): the real API's run puts them in the vault a year ago and runs
   * the reminders' tick for somebody turning 13 (`remindTurned13`); the
   * fake's makes the owners' reminder. Optional: a context from before has
   * none, and its scenarios never ask.
   */
  turnThirteen?: (memberId: string) => Promise<void>;
  /**
   * What a person's filing does to a file a connected app sent (0.9.0,
   * APP3): the real API's run files it from the app's batch in their Inbox,
   * as they would; the fake's, which has no Inbox for it, files it as a new
   * document of theirs. The document it became.
   */
  fileAppSend?: (
    token: string,
    app: { id: string; name: string },
    externalId: string,
    file: { sha256: string; bytes: Uint8Array },
  ) => Promise<string>;
  /**
   * The same, but filed as a new version of a document that is there
   * (0.9.0, APP6): the real API's run accepts the app's item into that
   * document, as a person would; the fake's adds the file as its newest
   * version and files the send as one.
   */
  fileAppSendAsVersion?: (
    token: string,
    app: { id: string; name: string },
    externalId: string,
    file: { sha256: string; bytes: Uint8Array },
    documentId: string,
  ) => Promise<void>;
  /**
   * The fetch the vault answers on (0.9.0, APP1): a connected app's client
   * of its own, beside the family's, sends its API key through it.
   */
  fetch?: FetchLike;
  /**
   * A connected app's API key past its expiry now (0.9.0, APP6), as time
   * would make it: the real API's run writes it as the owning role; the
   * fake's moves its key's dates. Optional: without it the expired case is
   * not asked.
   */
  expireAppKey?: (clientId: string) => Promise<void>;
  /**
   * Every connected app's access token past its end now (0.9.0-dev.72), as
   * time would make it: the real API's run moves their dates as the owning
   * role; the fake's moves its own. Optional: a context from before has
   * none, and the scenario leaves that part out.
   */
  expireAppTokens?: () => Promise<void>;
  /**
   * The pages of a file a connected app sent read as this proposal, and
   * what the vault does once a read finishes (0.9.0, APP4): the real API's
   * run writes the reading as the worker does and runs the `apps.file_ready`
   * job the worker would send; the fake's says what the pages read
   * (`readAppFile`).
   */
  readAppSend?: (
    app: { id: string },
    externalId: string,
    file: { sha256: string },
    proposal: DetailProposal,
  ) => Promise<void>;
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
const SUGGESTIONS_KEY = '8192a3b4-c5d6-4e78-9f80-123456789abc';
const CREATE_KEY = '92a3b4c5-d6e7-4f89-8a91-23456789abcd';
const ZIP_KEY = 'a3b4c5d6-e7f8-4a9b-8c0d-3456789abcde';
const LK_KEY = 'b4c5d6e7-f809-4bac-9d1e-456789abcdef';
const H5_KEY = 'c5d6e7f8-091a-4bcd-8e2f-56789abcdef0';
/**
 * The owner the connected app scenario signed in, with two-step sign-in on
 * and a code just given: the reading scenario after it acts as them.
 */
let connectedAppOwner: Tokens | undefined;
/** Captures of the connected app reading scenario (0.9.0, APP2). */
const APP2_KEYS = [
  'b5c6d7e8-f90a-4b1c-8d2e-3f4a5b6c7d81',
  'b5c6d7e8-f90a-4b1c-8d2e-3f4a5b6c7d82',
  'b5c6d7e8-f90a-4b1c-8d2e-3f4a5b6c7d83',
  'b5c6d7e8-f90a-4b1c-8d2e-3f4a5b6c7d84',
] as const;
/** The every-byte scenario's capture and new version (CL3). */
const CL3_KEYS = [
  'd6e7f809-1a2b-4c3d-8e4f-5a6b7c8d9e01',
  'd6e7f809-1a2b-4c3d-8e4f-5a6b7c8d9e02',
] as const;
/** A capture of the connected app links scenario (0.9.0, APP3). */
const APP3_KEY = 'c6d7e8f9-0a1b-4c2d-8e3f-4a5b6c7d8e91';
/** The family's newer file of the versions scenario (APP6). */
const ORIGIN_KEY = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a51';
/**
 * An app's client with an API key an owner generated for it (0.9.0, APP6):
 * every permission the app has, for 30 days unless a scenario says.
 */
async function keyedApp(
  api: Api,
  token: string,
  made: { id: string; scopes: AppScope[] },
  fetch: FetchLike,
  o: { permissions?: AppScope[]; days?: number | null } = {},
): Promise<{ app: AppClient; clientId: string; secret: string; keyId: string }> {
  const key = await api.connectedApps.generateKey(token, made.id, {
    permissions: o.permissions ?? made.scopes,
    expires_in_days: o.days === undefined ? 30 : o.days,
  });
  return {
    app: createAppClient({
      url: api.http.baseUrl,
      clientId: key.client_id,
      secret: key.secret,
      fetch,
    }),
    clientId: key.client_id,
    secret: key.secret,
    keyId: key.key.id,
  };
}

/**
 * A file no text decoding survives (CL3): a PDF's first line, then every
 * byte value twice, then lines that look like a multipart boundary and a
 * part's headers — CRLF and dashes — and the end of a PDF. Each `label`
 * makes a file of its own.
 */
function everyByte(label: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks = [
    enc.encode(`%PDF-1.4\n% ${label}\n`),
    Uint8Array.from({ length: 512 }, (_, i) => i % 256),
    enc.encode(
      '\r\n--fdv-00112233445566778899aabbccddeeff0011\r\nContent-Disposition: form-data; name="file"\r\n\r\n\r\n--\r\n',
    ),
    Uint8Array.from({ length: 256 }, (_, i) => 255 - i),
    enc.encode('\n%%EOF\n'),
  ];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Bytes' SHA-256, in hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A version's file, by the family's ordinary download: exactly the bytes, and their hash. */
async function downloaded(
  api: Api,
  token: string,
  versionId: string,
): Promise<{ bytes: Uint8Array; sha256: string; disposition: string | null }> {
  const res = await api.content(token, versionId);
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    disposition: res.headers.get('content-disposition'),
  };
}

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
      const caps = await api.capabilities();
      const outcome = negotiate(caps, {
        // About setup, not versions: a client as new as the vault asks
        // (since 0.9.0-dev.79 the oldest phone app it works with), and every
        // server version new enough.
        clientVersion: caps.min_client_version,
        minServerVersion: '0.0.0',
      });
      expect(outcome.kind).toBe('setup_required');
    },
  },
  {
    name: 'setting it up opens a session for the first owner',
    run: async (api, ctx) => {
      const t = await api.setup({
        ...(ctx.setupToken ? { setup_token: ctx.setupToken } : {}),
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
    name: 'a create sent twice under one Idempotency-Key is made once (0.9.0-dev.45)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.idempotent_create).toBe(true);
      const before = (await api.documents(token)).items.length;
      const body = { title: 'Contract note, sent twice', notes: 'Under the **sink**' };
      const first = await api.createDocument(token, body, { idempotencyKey: CREATE_KEY });
      const again = await api.createDocument(token, body, { idempotencyKey: CREATE_KEY });
      expect(again.id).toBe(first.id);
      expect((await api.documents(token)).items.length).toBe(before + 1);
      // Another body under the same key is refused, and makes nothing.
      const reused = await refusal(
        api.createDocument(token, { ...body, title: 'Another' }, { idempotencyKey: CREATE_KEY }),
      );
      expect([reused.status, reused.code]).toEqual([422, 'idempotency_key_reused']);
      // A key past 255 characters is no key at all.
      const bad = await refusal(
        api.createDocument(token, body, { idempotencyKey: 'k'.repeat(256) }),
      );
      expect([bad.status, bad.code]).toEqual([400, 'invalid_idempotency_key']);
      expect((await api.documents(token)).items.length).toBe(before + 1);
      // A create refused (here, a kind the vault does not have) keeps no
      // key: put right, the same key makes it, never "reused".
      const refusedKey = `${CREATE_KEY}-refused`;
      const refused = await refusal(
        api.createDocument(
          token,
          { title: 'Contract note, refused', type_key: 'no_such_kind' },
          { idempotencyKey: refusedKey },
        ),
      );
      expect(refused.status).toBe(422);
      const putRight = await api.createDocument(
        token,
        { title: 'Contract note, put right' },
        { idempotencyKey: refusedKey },
      );
      expect(putRight.title).toBe('Contract note, put right');
      await api.deleteDocument(token, putRight.id);
    },
  },
  {
    name: 'the activity log says who did it, by id where it names them, and what sort of thing (R4)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      // Not sensitive: a sensitive one's line says "a sensitive document" (0.9.0, H1a).
      const doc = await api.createDocument(token, {
        title: 'Contract activity bill',
        sensitive: false,
      });
      const me = await api.me(token);
      const line = (await api.activity(token)).items.find(
        (l) => l.document_id === doc.id && l.text.endsWith('added “Contract activity bill”'),
      );
      expect(line).toMatchObject({ actor_member_id: me.member_id, kind: 'added' });
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
    name: 'pages nobody has read yet propose nothing, and the vault says so (5.37)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.detail_suggestions).toBe(true);
      const made = await api.capture(
        token,
        {
          metadata: { title: 'Contract scan' },
          file: {
            kind: 'bytes',
            filename: 'scan.pdf',
            contentType: 'application/pdf',
            bytes: PDF,
          },
        },
        SUGGESTIONS_KEY,
      );
      const offered = await api.detailSuggestions(token, made.document_id);
      expect(['pending', 'unavailable']).toContain(offered.state);
      expect(offered.proposal).toEqual({});
      // A document that is not there is not there.
      const missing = await refusal(
        api.detailSuggestions(token, '00000000-0000-4000-8000-000000000000'),
      );
      expect(missing.status).toBe(404);
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
      // Nor, since the Phase 5 exit, does a password alone write another
      // person's details (A54): refused, and nothing written.
      const other = await ctx.addSignIn(token, {
        name: 'Identity Adult',
        email: 'identity-adult@example.test',
        password: 'another correct horse',
        role: 'adult',
      });
      const overwritten = await refusal(
        api.updateIdentity(token, other, {
          part: 'shared',
          version: 0,
          fields: { given_name: 'Overwritten' },
        }),
      );
      expect(overwritten).toMatchObject({
        status: 403,
        code: 'totp_required_for_owner',
        message: "Turn on two-step sign-in to change another person's identity details.",
      });
      expect((await api.identity(token, other)).versions.shared).toBe(0);
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
    name: 'an owner limits what a viewer can see: the preview counts it as the vault will give it, only a collection for Everyone, the viewer is told on /me, and the limits come off (5.33)',
    run: async (api, ctx) => {
      expect((await api.capabilities()).features.access_restrictions).toBe(true);
      const first = await signIn(api, ctx);
      const vera = { email: 'limited-viewer@example.test', password: 'the viewer’s own password' };
      const veraId = await ctx.addSignIn(first.access_token, {
        name: 'Vera',
        role: 'viewer',
        ...vera,
      });
      const ravi = { email: 'granted-adult@example.test', password: 'the adult’s own password' };
      const raviId = await ctx.addSignIn(first.access_token, {
        name: 'Ravi',
        role: 'adult',
        ...ravi,
      });
      const fifth = { email: 'fifth-owner@example.test', password: 'the fifth owner’s password' };
      await ctx.addSignIn(first.access_token, { name: 'Fifth Owner', role: 'owner', ...fifth });
      const owner = await signInAs(api, fifth.email, fifth.password);
      await ctx.ownerTwoStep(owner.access_token);

      // Ravi's statement and bill, an Adults only statement of his; Vera's own bill.
      const doc = (type_key: string, member: string, visibility: 'household' | 'adults') =>
        api.createDocument(owner.access_token, {
          title: `Limits ${type_key} ${visibility}`,
          type_key,
          owner_member_id: member,
          visibility,
        });
      await doc('bank_statement', raviId, 'household');
      const bill = await doc('utility_bill', raviId, 'household');
      await doc('bank_statement', raviId, 'adults');
      await doc('utility_bill', veraId, 'household');
      const broker = await api.createCollection(owner.access_token, {
        name: 'For the broker',
        audience: 'everyone',
      });
      await api.addToCollection(owner.access_token, broker.id, [bill.id]);
      const teens = await api.createCollection(owner.access_token, {
        name: 'Teen papers',
        audience: 'teens',
      });

      // Who may: an owner, of a viewer, with collections for Everyone.
      const asAdult = await signInAs(api, ravi.email, ravi.password);
      expect(
        await refusal(api.setMemberAccess(asAdult.access_token, veraId, { people: [raviId] })),
      ).toMatchObject({ status: 403, code: 'forbidden' });
      // In one order (the 5.33 review): whom, before what the grant names —
      // nobody of the family 404, anybody but a viewer 409, then 422.
      expect(
        await refusal(
          api.setMemberAccess(owner.access_token, '00000000-0000-4000-8000-000000000533', {
            collections: [teens.id],
          }),
        ),
      ).toMatchObject({ status: 404, code: 'not_found' });
      expect(
        await refusal(api.setMemberAccess(owner.access_token, raviId, { collections: [teens.id] })),
      ).toMatchObject({ status: 409, code: 'not_a_viewer' });
      expect(
        await refusal(api.setMemberAccess(owner.access_token, veraId, { collections: [teens.id] })),
      ).toMatchObject({
        status: 422,
        message: onlyEveryone('Teen papers', 'teens'),
      });

      // Counted before it is saved: Ravi's statement, and her own bill...
      const grant = { people: [raviId], types: ['bank_statement'] };
      expect(await api.previewAccess(owner.access_token, veraId, grant)).toEqual({
        documents: 2,
        keeps_private: false,
      });
      // ...his Adults only one too, when an owner allows it...
      expect(
        (
          await api.previewAccess(owner.access_token, veraId, {
            ...grant,
            include_adults_only: true,
          })
        ).documents,
      ).toBe(3);
      // ...and the broker's collection, a separate way in (A56).
      const given = { ...grant, collections: [broker.id] };
      expect((await api.previewAccess(owner.access_token, veraId, given)).documents).toBe(3);
      // For somebody not yet in the family, nothing of their own.
      expect((await api.previewAccess(owner.access_token, null, given)).documents).toBe(2);

      const limited = await api.setMemberAccess(owner.access_token, veraId, given);
      expect(limited).toMatchObject({
        member_id: veraId,
        people: [raviId],
        types: ['bank_statement'],
        collections: [broker.id],
        include_adults_only: false,
        include_no_person_docs: false,
        expires_at: null,
        limits_people: true,
        limits_types: true,
        reconfirm_since: null,
        private_confirmed: false,
        summary: "Restricted: sees 1 person's documents of 1 kind and 1 collection.",
      });
      // Kept as shown — the flags too — it is the same, and nothing widens.
      const kept = await api.setMemberAccess(owner.access_token, veraId, {
        people: limited.people,
        types: limited.types,
        collections: limited.collections,
        include_adults_only: limited.include_adults_only,
        include_no_person_docs: limited.include_no_person_docs,
        expires_at: limited.expires_at,
        limits_people: limited.limits_people,
        limits_types: limited.limits_types,
      });
      expect(kept.summary).toBe(limited.summary);
      // She is told, in her words, on her next request.
      const asVera = await signInAs(api, vera.email, vera.password);
      const told = (await api.me(asVera.access_token)).restriction;
      expect(told).toMatchObject({
        people: [{ id: raviId, display_name: 'Ravi' }],
        types: [{ key: 'bank_statement' }],
        collections: [{ id: broker.id, name: 'For the broker' }],
      });
      expect(told?.summary).toMatch(
        /^You can see: .+ documents for Ravi, the collection “For the broker” and your own\.$/,
      );
      // Nobody else is limited.
      expect((await api.me(owner.access_token)).restriction ?? null).toBeNull();

      // A kind named and deleted since (R532-01; the 5.33 second round): the
      // card names no kind and still limits by kind; put back as shown, it
      // is the same, and nothing more is given.
      const boat = await api.createDocumentType(owner.access_token, {
        label: 'Contract boat papers',
        category: 'other',
      });
      await api.setMemberAccess(owner.access_token, veraId, {
        people: [raviId],
        types: [boat.key],
      });
      await api.deleteDocumentType(owner.access_token, boat.key);
      const card = (await api.memberAccount(owner.access_token, veraId)).access;
      expect(card).toMatchObject({
        people: [raviId],
        types: [],
        limits_people: true,
        limits_types: true,
      });
      if (!card) throw new Error('her limits went with the kind');
      const asShown = {
        people: card.people,
        types: card.types,
        collections: card.collections,
        include_adults_only: card.include_adults_only,
        include_no_person_docs: card.include_no_person_docs,
        expires_at: card.expires_at,
        limits_people: card.limits_people,
        limits_types: card.limits_types,
      };
      const putBack = await api.setMemberAccess(owner.access_token, veraId, asShown);
      expect(putBack).toMatchObject({ types: [], limits_types: true, summary: card.summary });
      // Her own bill, and nothing of Ravi's.
      expect((await api.previewAccess(owner.access_token, veraId, asShown)).documents).toBe(1);

      // Taken off: she is told nothing more, and sees as any viewer does.
      await api.removeMemberAccess(owner.access_token, veraId);
      expect((await api.me(asVera.access_token)).restriction ?? null).toBeNull();
      // Nothing to take off is no refusal.
      await api.removeMemberAccess(owner.access_token, veraId);
    },
  },
  {
    name: 'an owner invites someone outside the family: a guest is a viewer, always limited, never among the family, with an end an owner renews (5.34)',
    run: async (api, ctx) => {
      const caps = await api.capabilities();
      expect(caps.features.guests).toBe(true);
      expect(caps.limits.guest_max_days).toBe(366);
      const first = await signIn(api, ctx);
      const sixth = { email: 'sixth-owner@example.test', password: 'the sixth owner’s password' };
      const sixthId = await ctx.addSignIn(first.access_token, {
        name: 'Sixth Owner',
        role: 'owner',
        ...sixth,
      });
      const owner = await signInAs(api, sixth.email, sixth.password);
      await ctx.ownerTwoStep(owner.access_token);
      const day = 24 * 60 * 60 * 1000;
      const at = (days: number) =>
        new Date(Math.floor(Date.now() / 1000) * 1000 + days * day).toISOString();
      const grant = { people: [sixthId], types: ['bank_statement'] };
      const asked = {
        display_name: 'Jane Smith',
        relationship: 'attorney',
        email: 'guest-attorney@example.test',
        role: 'viewer' as const,
        kind: 'guest' as const,
        restriction: grant,
        access_expires_at: at(30),
      };

      // A guest is a viewer, always limited, with an end within a year.
      const unlimited = { ...asked, restriction: null };
      expect(await refusal(api.invite(owner.access_token, unlimited))).toMatchObject({
        status: 422,
        code: 'validation_failed',
      });
      expect(
        await refusal(api.invite(owner.access_token, { ...asked, access_expires_at: at(400) })),
      ).toMatchObject({ status: 422, code: 'validation_failed' });
      expect(
        await refusal(api.invite(owner.access_token, { ...asked, role: 'adult' })),
      ).toMatchObject({ status: 422, code: 'validation_failed' });

      const made = await api.invite(owner.access_token, asked);
      expect(made.invitation).toMatchObject({
        kind: 'guest',
        role: 'viewer',
        limited: true,
        access_expires_at: asked.access_expires_at,
      });
      const guest = await api.acceptInvitationLink(made.link_token, {
        code: made.code,
        password: 'the attorney’s own password',
      });
      expect(guest.role).toBe('viewer');
      const me = await api.me(guest.access_token);
      expect(me).toMatchObject({
        role: 'viewer',
        kind: 'guest',
        access_expires_at: asked.access_expires_at,
      });
      // What she can see, in her words: nothing "of her own", a guest owns nothing.
      expect(me.restriction?.summary).toMatch(/^You can see: .+ documents for Sixth Owner\.$/);

      // Never among the family: an owner lists them apart.
      const family = (await api.members(owner.access_token)).items;
      expect(family.some((m) => m.id === guest.member_id)).toBe(false);
      expect(family.every((m) => (m.kind ?? 'family') === 'family')).toBe(true);
      const outside = (await api.guests(owner.access_token)).items;
      expect(outside.map((m) => m.id)).toEqual([guest.member_id]);
      expect(outside[0]).toMatchObject({
        display_name: 'Jane Smith',
        kind: 'guest',
        access_expires_at: asked.access_expires_at,
      });
      // The guest sees themselves as one; nobody but an owner lists the guests.
      const theirs = (await api.members(guest.access_token)).items;
      expect(theirs.find((m) => m.id === guest.member_id)?.kind).toBe('guest');
      expect(await refusal(api.guests(guest.access_token))).toMatchObject({ status: 403 });

      // A viewer and nothing else; limited for good.
      expect(
        await refusal(api.setRole(owner.access_token, guest.member_id, 'adult')),
      ).toMatchObject({ status: 409, code: 'guest' });
      expect(
        await refusal(api.removeMemberAccess(owner.access_token, guest.member_id)),
      ).toMatchObject({ status: 409, code: 'guest_always_limited' });

      // Renewed by an owner, within a year; only a guest's sign-in has an end.
      expect(
        await refusal(api.renewGuest(owner.access_token, guest.member_id, at(400))),
      ).toMatchObject({ status: 422 });
      expect(await refusal(api.renewGuest(owner.access_token, sixthId, at(60)))).toMatchObject({
        status: 409,
        code: 'not_a_guest',
      });
      const sixty = at(60);
      const renewed = await api.renewGuest(owner.access_token, guest.member_id, sixty);
      expect(renewed).toEqual({ member_id: guest.member_id, access_expires_at: sixty });
      expect((await api.me(guest.access_token)).access_expires_at).toBe(sixty);

      // Past its end (A28): every session answers nothing, `access_ended`,
      // a refresh too; signing in is refused once the password is right,
      // with the day — and renewed, she is in again.
      if (!ctx.endGuestAccess) throw new Error('the contract needs endGuestAccess');
      await ctx.endGuestAccess(guest.member_id);
      const over = await refusal(api.me(guest.access_token));
      expect(over).toMatchObject({ status: 401, code: 'session_ended', reason: 'access_ended' });
      expect(isSessionOver(over)).toBe(true);
      const refreshed = await refusal(api.refresh(guest.refresh_token));
      expect(refreshed).toMatchObject({ status: 401, reason: 'access_ended' });
      const password = 'the attorney’s own password';
      const ended = await refusal(api.signIn('guest-attorney@example.test', password));
      expect(ended).toMatchObject({ status: 403, code: 'access_ended', reason: 'access_ended' });
      expect(ended.message).toMatch(/^Your access to this family vault ended .+ \d{4} at /);
      await api.renewGuest(owner.access_token, guest.member_id, at(30));
      await signInAs(api, 'guest-attorney@example.test', password);
    },
  },
  {
    name: 'the Documents table filtered by several values, comma-separated, and by days, both ends included (V1)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.document_filters).toBe(true);
      const TAG = 'v1-filters';
      for (const [key, type_key, expires] of [
        ['one', 'passport', '2030-06-01'],
        ['two', 'passport', '2034-01-01'],
        ['three', 'bank_statement', null],
      ] as const) {
        await api.createDocument(token, {
          title: `V1 filter ${key}`,
          type_key,
          tags: [TAG],
          ...(expires ? { expires: { date: expires, precision: 'day' as const } } : {}),
        });
      }
      const titles = (page: { items: Array<{ title: string | null }> }) =>
        page.items.map((d) => d.title?.replace(/^V1 filter /, ''));
      // Any of the kinds asked for.
      const kinds = await api.documents(token, {
        sort: 'title',
        tag: TAG,
        type_key: 'passport,bank_statement',
      });
      expect(titles(kinds)).toEqual(['one', 'three', 'two']);
      expect(kinds.total).toBe(3);
      // Within the days, both ends included; one with no expiry is in no range.
      const within = await api.documents(token, {
        sort: 'title',
        tag: TAG,
        expires_from: '2030-06-01',
        expires_to: '2033-12-31',
      });
      expect(titles(within)).toEqual(['one']);
      // What it cannot read is refused, saying which.
      const refused = await refusal(
        api.documents(token, { sort: 'title', tag: TAG, status: 'expired,lost' as never }),
      );
      expect(refused).toMatchObject({ status: 422, code: 'validation_failed' });
    },
  },
  {
    name: 'the Documents table: sorted by a column either way with blanks last, filtered, a page at a time by its cursor with how many in all; a viewer may not sort or filter by where originals are kept (R2)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.document_table).toBe(true);
      const TAG = 'r2-table';
      const made: Record<string, string> = {};
      for (const [key, issued, where] of [
        ['charlie', '2021-03-01', 'Loft'],
        ['alpha', null, 'Desk'],
        ['bravo', '2019-07-15', null],
        ['delta', '2023-11-30', 'desk'],
      ] as const) {
        const doc = await api.createDocument(token, {
          title: `${key === 'alpha' ? 'contract' : 'Contract'} table ${key}`,
          tags: [TAG],
          physical_location: where,
          ...(issued ? { issued: { date: issued, precision: 'day' as const } } : {}),
        });
        made[key] = doc.id;
      }
      const titles = (page: { items: Array<{ title: string | null }> }) =>
        page.items.map((d) => d.title?.replace(/^contract table /i, ''));

      // By title, case aside; and the other way.
      const byTitle = await api.documents(token, { sort: 'title', tag: TAG });
      expect(titles(byTitle)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
      expect(byTitle).toMatchObject({ total: 4, has_more: false, next_cursor: null });
      const down = await api.documents(token, { sort: 'title', direction: 'desc', tag: TAG });
      expect(titles(down)).toEqual(['delta', 'charlie', 'bravo', 'alpha']);
      // By the day it was issued: the one with none last, whichever way.
      expect(titles(await api.documents(token, { sort: 'issued', tag: TAG }))).toEqual([
        'bravo',
        'charlie',
        'delta',
        'alpha',
      ]);
      expect(
        titles(await api.documents(token, { sort: 'issued', direction: 'desc', tag: TAG })),
      ).toEqual(['delta', 'charlie', 'bravo', 'alpha']);

      // Two at a time: the same order, nothing twice, and how many in all on each page.
      const first = await api.documents(token, { sort: 'issued', tag: TAG, limit: 2 });
      expect(titles(first)).toEqual(['bravo', 'charlie']);
      expect(first).toMatchObject({ total: 4, has_more: true });
      const second = await api.documents(token, {
        sort: 'issued',
        tag: TAG,
        limit: 2,
        cursor: first.next_cursor as string,
      });
      expect(titles(second)).toEqual(['delta', 'alpha']);
      expect(second).toMatchObject({ total: 4, has_more: false, next_cursor: null });
      // A cursor is for the sort and the direction it came with.
      for (const other of [
        { sort: 'title' as const },
        { sort: 'issued' as const, direction: 'desc' as const },
      ]) {
        const refused = await refusal(
          api.documents(token, { ...other, tag: TAG, cursor: first.next_cursor as string }),
        );
        expect(refused).toMatchObject({ status: 422, code: 'validation_failed' });
      }

      // Filters: where it is kept, whatever the case; nobody's; a collection, or none.
      expect(
        titles(await api.documents(token, { sort: 'title', tag: TAG, location: 'DESK' })),
      ).toEqual(['alpha', 'delta']);
      expect(
        (await api.documents(token, { sort: 'title', tag: TAG, member_id: 'none' })).total,
      ).toBe(4);
      const box = await api.createCollection(token, {
        name: 'Contract table box',
        audience: 'everyone',
      });
      await api.addToCollection(token, box.id, [made.charlie as string, made.alpha as string]);
      const inBox = await api.documents(token, { sort: 'title', tag: TAG, collection_id: box.id });
      expect(titles(inBox)).toEqual(['alpha', 'charlie']);
      expect(inBox.items.map((d) => d.collections?.map((c) => c.name))).toEqual([
        ['Contract table box'],
        ['Contract table box'],
      ]);
      expect(
        titles(await api.documents(token, { sort: 'title', tag: TAG, collection_id: 'none' })),
      ).toEqual(['bravo', 'delta']);
      // Sorted by collection: those in one first, those in none last.
      const byBox = titles(await api.documents(token, { sort: 'collections', tag: TAG }));
      expect([...byBox.slice(0, 2)].sort()).toEqual(['alpha', 'charlie']);
      expect([...byBox.slice(2)].sort()).toEqual(['bravo', 'delta']);
      // The family sorts by where originals are kept; blanks last.
      const byPlace = await api.documents(token, { sort: 'location', tag: TAG });
      expect(byPlace.items.map((d) => d.physical_location?.toLowerCase() ?? null)).toEqual([
        'desk',
        'desk',
        'loft',
        null,
      ]);

      // An older sort is answered as before, and refuses what the table adds.
      const older = await refusal(api.documents(token, { sort: 'recent', direction: 'asc' }));
      expect(older).toMatchObject({ status: 422, code: 'validation_failed' });

      // A viewer sorts and filters what they are given, and never by where it is kept.
      const vic = { email: 'table-viewer@example.test', password: 'the viewer’s own password' };
      await ctx.addSignIn(token, { name: 'Vic', role: 'viewer', ...vic });
      const viewer = await signInAs(api, vic.email, vic.password);
      const theirs = await api.documents(viewer.access_token, { sort: 'title', tag: TAG });
      expect(titles(theirs)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
      expect(theirs.items.every((d) => d.physical_location === null)).toBe(true);
      for (const asked of [
        { sort: 'location' as const, tag: TAG },
        { sort: 'title' as const, tag: TAG, location: 'Desk' },
      ]) {
        const refused = await refusal(api.documents(viewer.access_token, asked));
        expect(refused).toMatchObject({ status: 422, code: 'validation_failed' });
      }

      // Nor is a viewer told, by a status, that where it is kept is not
      // written down (5.41): not in the table's words, its sort, or a filter.
      const BOXED = 'r2-table-boxed';
      const me = await api.me(token);
      const kind = await api.createDocumentType(token, {
        label: 'Contract deeds box',
        category: 'property',
        core: { physical_location: { required: true } },
      });
      const deed = await api.createDocument(token, {
        title: 'Contract boxed deed',
        type_key: kind.key,
        owner_member_id: me.member_id,
        tags: [BOXED],
      });
      const ownersView = (await api.document(token, deed.id)).status;
      expect(ownersView.value).toBe('needs_info');
      const viewersView = (await api.document(viewer.access_token, deed.id)).status;
      expect(viewersView.value).not.toBe('needs_info');
      for (const [who, view] of [
        [token, ownersView],
        [viewer.access_token, viewersView],
      ] as const) {
        const sorted = await api.documents(who, { sort: 'status', tag: BOXED });
        expect(sorted.items.map((d) => d.status)).toEqual([view]);
        for (const sort of ['title', 'status'] as const) {
          const asking = await api.documents(who, { sort, tag: BOXED, status: 'needs_info' });
          expect(asking.total).toBe(view.value === 'needs_info' ? 1 : 0);
          const its = await api.documents(who, { sort, tag: BOXED, status: view.value });
          expect(its.total).toBe(1);
        }
      }
    },
  },
  {
    name: "a note as the vault keeps it: its words as written, and who last changed them and when — moved only by a change of its words, and never over somebody else's (5.35)",
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      const made = await api.createDocument(token, {
        title: 'Contract boiler',
        notes: 'Serviced **every** May\n- [ ] book it',
      });
      expect(made.notes).toBe('Serviced **every** May\n- [ ] book it');
      expect(made.notes_updated_at).toEqual(expect.any(String));
      expect(made.notes_updated_by_name).toEqual(expect.any(String));
      const bare = await api.createDocument(token, { title: 'Contract fuse box' });
      expect(bare.notes_updated_at ?? null).toBeNull();
      // Anything else changed, or the same words saved again: it stands.
      const retitled = await api.updateDocument(
        token,
        made.id,
        { title: 'Contract boiler, upstairs' },
        made.etag,
      );
      expect(retitled.notes_updated_at).toBe(made.notes_updated_at);
      const same = await api.updateDocument(
        token,
        made.id,
        { notes: ' Serviced **every** May\n- [ ] book it\n' },
        retitled.etag,
      );
      expect(same.notes_updated_at).toBe(made.notes_updated_at);
      // The words changed: it moves.
      const changed = await api.updateDocument(
        token,
        made.id,
        { notes: '- [x] serviced in May' },
        same.etag,
      );
      expect(Date.parse(changed.notes_updated_at as string)).toBeGreaterThanOrEqual(
        Date.parse(made.notes_updated_at as string),
      );
      expect(changed.notes_updated_by_name).toBe(made.notes_updated_by_name);
      // Saved from an older copy: refused, and theirs is kept.
      const stale = await refusal(
        api.updateDocument(token, made.id, { notes: 'From an older copy' }, made.etag),
      );
      expect(stale).toMatchObject({ status: 409, code: 'conflict' });
      expect((await api.document(token, made.id)).notes).toBe('- [x] serviced in May');
    },
  },
  {
    name: 'where a paper original is kept is the household’s: an adult and a teen are told it; a viewer is answered null, in the document and in the list (5.41)',
    run: async (api, ctx) => {
      const first = await signIn(api, ctx);
      const lou = { email: 'location-viewer@example.test', password: 'the viewer’s own password' };
      await ctx.addSignIn(first.access_token, { name: 'Lou', role: 'viewer', ...lou });
      const tia = { email: 'location-teen@example.test', password: 'the teen’s own password' };
      await ctx.addSignIn(first.access_token, { name: 'Tia', role: 'teen', ...tia });
      const WHERE = 'Loft, in the blue trunk';
      const made = await api.createDocument(first.access_token, {
        title: 'Contract deeds box',
        physical_location: WHERE,
      });
      expect(made.physical_location).toBe(WHERE);
      const told = async (token: string) => [
        (await api.document(token, made.id)).physical_location,
        (await api.documents(token)).items.find((d) => d.id === made.id)?.physical_location,
      ];
      const teen = await signInAs(api, tia.email, tia.password);
      expect(await told(teen.access_token)).toEqual([WHERE, WHERE]);
      // A viewer sees the document, and never where its original is.
      const viewer = await signInAs(api, lou.email, lou.password);
      expect(await told(viewer.access_token)).toEqual([null, null]);
      // It is still kept, and still the household's to read.
      expect(await told(first.access_token)).toEqual([WHERE, WHERE]);
    },
  },
  {
    name: 'many documents at once: a batch with defaults, two files the same, one accepted with every detail and the defaults filling what was not said, the other removed; a viewer refused (I1)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.batches).toBe(true);
      const me = await api.me(token);
      const made = await api.createBatch(token, {
        name: 'Contract batch',
        defaults: { tags: ['Contract-Batch'], is_essential: true, physical_location: 'Box 3' },
      });
      expect(made).toMatchObject({
        name: 'Contract batch',
        items: [],
        counts: { items: 0, waiting: 0, accepted: 0, removed: 0, duplicates: 0 },
        defaults: {
          owner_member_id: null,
          type_key: null,
          visibility: null,
          physical_location: 'Box 3',
          collection_id: null,
          tags: ['contract-batch'],
          is_essential: true,
        },
      });
      const bytes = new TextEncoder().encode('%PDF-1.4\n% the contract batch scan\n%%EOF\n');
      const file = (filename: string) => ({
        kind: 'bytes' as const,
        filename,
        contentType: 'application/pdf',
        bytes,
      });
      const first = await api.addBatchItem(token, made.id, file('scan-001.pdf'));
      const again = await api.addBatchItem(token, made.id, file('scan-001 (1).pdf'));
      expect(first).toMatchObject({
        batch_id: made.id,
        name: 'scan-001.pdf',
        content_type: 'application/pdf',
        byte_size: bytes.length,
        state: 'waiting',
        reading: 'waiting',
        duplicate: null,
        document_id: null,
      });
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      // The same bytes again: a duplicate, still the uploader's to accept or remove.
      expect(again.sha256).toBe(first.sha256);
      expect(again.duplicate).toMatchObject({ of: 'item', item_id: first.id, same_batch: true });
      const listed = (await api.batches(token)).items.find((b) => b.id === made.id);
      expect(listed?.counts).toEqual({
        items: 2,
        waiting: 2,
        accepted: 0,
        removed: 0,
        duplicates: 1,
      });

      // Accepted with every detail the card takes; what is not said takes the defaults.
      const done = await api.acceptBatchItem(token, made.id, first.id, {
        type_key: 'birth_certificate',
        title: 'Contract batch birth certificate',
        owner_member_id: me.member_id,
        visibility: 'household',
        issued: { date: '2021-03-14', precision: 'day' },
        identifier: 'BC-123456',
        issued_by: 'General Register Office',
        notes: 'Renew a year early',
        extra: { registration_no: 'R-1234', place_of_birth: 'Leeds' },
      });
      const doc = await api.document(token, done.document_id);
      expect(doc).toMatchObject({
        type_key: 'birth_certificate',
        title: 'Contract batch birth certificate',
        owner_member_id: me.member_id,
        visibility: 'household',
        issued: { date: '2021-03-14', precision: 'day' },
        identifier: 'BC-123456',
        issued_by: 'General Register Office',
        notes: 'Renew a year early',
        extra: { registration_no: 'R-1234', place_of_birth: 'Leeds' },
        tags: ['contract-batch'],
        is_essential: true,
        physical_location: 'Box 3',
      });
      // The copy now duplicates a document; removed, it is gone, and decided once.
      const now = await api.batch(token, made.id);
      expect(now.items.find((i) => i.id === again.id)?.duplicate).toMatchObject({
        of: 'document',
        document_id: done.document_id,
        title: 'Contract batch birth certificate',
      });
      await api.removeBatchItem(token, made.id, again.id);
      const left = await api.batch(token, made.id);
      expect(left.items.map((i) => [i.id, i.state, i.document_id])).toEqual([
        [first.id, 'accepted', done.document_id],
      ]);
      expect(left.counts).toEqual({ items: 1, waiting: 0, accepted: 1, removed: 1, duplicates: 0 });
      expect(await refusal(api.removeBatchItem(token, made.id, again.id))).toMatchObject({
        status: 409,
        code: 'already_decided',
      });

      // A viewer adds nothing, so makes no batch, and is shown none.
      const vee = { email: 'batch-viewer@example.test', password: 'the viewer’s own password' };
      await ctx.addSignIn(token, { name: 'Vee', role: 'viewer', ...vee });
      const viewer = await signInAs(api, vee.email, vee.password);
      for (const asked of [
        () => api.createBatch(viewer.access_token, {}),
        () => api.batches(viewer.access_token),
        () => api.batch(viewer.access_token, made.id),
      ]) {
        expect(await refusal(asked())).toMatchObject({ status: 403, code: 'forbidden' });
      }

      // The batch removed: gone, and what was accepted stays a document.
      await api.removeBatch(token, made.id);
      expect(await refusal(api.batch(token, made.id))).toMatchObject({ status: 404 });
      expect((await api.document(token, done.document_id)).id).toBe(done.document_id);
    },
  },
  {
    name: 'many documents at once, the review: a batch made Only me is its uploader’s own; a file sent again with its Idempotency-Key is the item it made; accepted, an item has no pages (I1)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      const me = await api.me(token);
      const mine = await api.createBatch(token, {
        name: 'Only mine',
        defaults: { visibility: 'private' },
      });
      // Only me is for one’s own documents: whose they are is the uploader.
      expect(mine.defaults).toMatchObject({ visibility: 'private', owner_member_id: me.member_id });
      const file = {
        kind: 'bytes' as const,
        filename: 'letter.pdf',
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode('%PDF-1.4\n% the contract review letter\n%%EOF\n'),
      };
      const key = '6f1f7c1e-3a8b-4c2d-9e0f-1a2b3c4d5e6f';
      const first = await api.addBatchItem(token, mine.id, file, key);
      // Its answer lost, sent again with its key: the item it made, not a second.
      const again = await api.addBatchItem(token, mine.id, file, key);
      expect(again.id).toBe(first.id);
      expect((await api.batch(token, mine.id)).items.map((i) => i.id)).toEqual([first.id]);
      // Accepted with nothing said: Only me, theirs, never wider.
      const done = await api.acceptBatchItem(token, mine.id, first.id, {});
      expect(await api.document(token, done.document_id)).toMatchObject({
        visibility: 'private',
        owner_member_id: me.member_id,
      });
      expect((await api.batch(token, mine.id)).items[0]).toMatchObject({
        state: 'accepted',
        preview_state: 'none',
        preview_pages: null,
      });
      await api.removeBatch(token, mine.id);
    },
  },
  {
    name: 'many documents at once, read and suggested: an item read is Ready, a confident disagreement with the batch is Check with both, pages not read and a duplicate are Problems, and an accept takes only what is sent (I2)',
    run: async (api, ctx) => {
      if (!ctx.readBatchItems) return;
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.batch_proposals).toBe(true);
      const me = await api.me(token);
      const ruth = await ctx.addSignIn(token, {
        name: 'Ruth',
        email: 'batch-ruth@example.test',
        password: 'Ruth’s own long password',
        role: 'adult',
      });
      const myName = (await api.members(token)).items.find((m) => m.is_me)?.display_name;
      const b = await api.createBatch(token, {
        name: 'Read for me',
        defaults: { owner_member_id: me.member_id },
      });
      const file = (n: string) => ({
        kind: 'bytes' as const,
        filename: `${n}.pdf`,
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode(`%PDF-1.4\n% the contract read ${n}\n%%EOF\n`),
      });
      const ready = await api.addBatchItem(token, b.id, file('ready'));
      const clash = await api.addBatchItem(token, b.id, file('clash'));
      const locked = await api.addBatchItem(token, b.id, file('locked'));
      const first = await api.addBatchItem(token, b.id, file('twice'));
      const twice = await api.addBatchItem(token, b.id, file('twice'));
      const waiting = await api.addBatchItem(token, b.id, file('waiting'));
      expect(waiting).toMatchObject({ reading: 'waiting', level: null, tags: [], clashes: [] });
      const day = (date: string) => ({ date, precision: 'day' as const });
      const passport = (owner: string): DetailProposal => ({
        type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
        owner_member_id: { value: owner, confidence: 0.9, cue: 'name_labelled' },
        expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
        identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
        issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
      });
      await ctx.readBatchItems(b.id, {
        [ready.id]: { proposal: passport(me.member_id) },
        [clash.id]: { proposal: passport(ruth) },
        [locked.id]: { failure: 'password' },
        [first.id]: { proposal: passport(me.member_id) },
        [twice.id]: { proposal: passport(me.member_id) },
      });
      const got = await api.batch(token, b.id);
      const by = (id: string) => got.items.find((i) => i.id === id);
      expect(by(ready.id)).toMatchObject({
        reading: 'read',
        read_failure: null,
        level: 'ready',
        tags: [],
        clashes: [],
        proposals: {
          type_key: { value: 'passport', from: 'pages', confidence: 0.97, cue: 'kind_words' },
          owner_member_id: { value: me.member_id, from: 'both', confidence: 0.9 },
          expires: { value: day('2031-03-14'), from: 'pages', confidence: 0.94 },
          identifier: { value: '533401872', from: 'pages', confidence: 0.95 },
          visibility: { value: 'household', from: 'kind' },
        },
      });
      expect(by(clash.id)).toMatchObject({
        level: 'check',
        clashes: [
          {
            field: 'owner_member_id',
            pages: { value: ruth, confidence: 0.9, cue: 'name_labelled' },
            batch: me.member_id,
          },
        ],
        tags: [
          {
            code: 'clash_person',
            kind: 'check',
            words: `The pages say Ruth, the batch says ${myName}`,
          },
        ],
        // The batch's stands until somebody chooses.
        proposals: { owner_member_id: { value: me.member_id, from: 'batch' } },
      });
      expect(by(locked.id)).toMatchObject({
        reading: 'failed',
        read_failure: 'password',
        level: 'problem',
        tags: [{ code: 'unread', kind: 'problem', words: 'Couldn’t read the pages' }],
      });
      expect(by(first.id)?.level).toBe('ready');
      expect(by(twice.id)).toMatchObject({
        level: 'problem',
        tags: [{ code: 'duplicate_in_batch', kind: 'problem', words: 'Also in this batch' }],
      });
      // Accepted with nothing said: the batch's defaults, and no proposal nobody chose.
      const done = await api.acceptBatchItem(token, b.id, ready.id, {});
      expect(await api.document(token, done.document_id)).toMatchObject({
        owner_member_id: me.member_id,
        type_key: null,
        identifier: null,
        expires: null,
        issued_by: null,
      });
      expect((await api.batch(token, b.id)).items.find((i) => i.id === ready.id)).toMatchObject({
        state: 'accepted',
        level: null,
        proposals: null,
      });
      await api.removeBatch(token, b.id);
    },
  },
  {
    name: 'folder names suggest the kind, whose it is and tags: kept for the uploader as `folder`, from the folder alone unsure, with the pages agreeing Ready, disagreeing Check (0.8.0, S2)',
    run: async (api, ctx) => {
      if (!ctx.readBatchItems) return;
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.folder_suggestions).toBe(true);
      const ruth = await ctx.addSignIn(token, {
        name: 'Rukhsana',
        email: 'folder-rukhsana@example.test',
        password: 'Rukhsana’s own long password',
        role: 'adult',
      });
      const b = await api.createBatch(token, { name: 'From the folders' });
      const file = (n: string) => ({
        kind: 'bytes' as const,
        filename: `${n}.pdf`,
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode(`%PDF-1.4\n% the contract folders ${n}\n%%EOF\n`),
      });
      const add = (n: string, path: string) =>
        api.addBatchItem(token, b.id, file(n), undefined, { relativePath: path });
      const agree = await add('agree', 'Rukhsana/Passports/agree.pdf');
      const against = await add('against', 'Bank statements/against.pdf');
      const alone = await add('alone', 'Rukhsana/Bank_Statements/2024');
      const none = await api.addBatchItem(token, b.id, file('none'));
      // Kept for the uploader, without the file's own name.
      expect(agree.folder).toBe('Rukhsana/Passports');
      expect(alone.folder).toBe('Rukhsana/Bank_Statements/2024');
      expect(none.folder ?? null).toBeNull();
      const day = (date: string) => ({ date, precision: 'day' as const });
      const passport = (sure: number): DetailProposal => ({
        type_key: { value: 'passport', confidence: sure, cue: 'kind_words' },
        owner_member_id: { value: ruth, confidence: sure, cue: 'name_labelled' },
        expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
        identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
      });
      await ctx.readBatchItems(b.id, {
        [agree.id]: { proposal: passport(0.8) },
        [against.id]: { proposal: passport(0.97) },
        [alone.id]: { proposal: {} },
        [none.id]: { proposal: passport(0.8) },
      });
      const got = await api.batch(token, b.id);
      const by = (id: string) => got.items.find((i) => i.id === id);
      // The pages unsure, the folder agreeing: surer, and Ready.
      expect(by(agree.id)).toMatchObject({
        level: 'ready',
        folder: 'Rukhsana/Passports',
        proposals: {
          type_key: { value: 'passport', from: 'pages', confidence: 0.9, folder: true },
          owner_member_id: { value: ruth, from: 'pages', confidence: 0.9, folder: true },
        },
      });
      // The same pages with no folder: Check.
      expect(by(none.id)?.level).toBe('check');
      // The folder disagreeing: the pages stand, and Check with both said.
      expect(by(against.id)).toMatchObject({
        level: 'check',
        proposals: { type_key: { value: 'passport', from: 'pages' } },
      });
      expect(by(against.id)?.tags?.find((t) => t.code === 'clash_folder')?.words).toBe(
        'The folder says Bank statement; the pages look like a passport',
      );
      // From the folder alone: shown, unsure — never Ready.
      expect(by(alone.id)).toMatchObject({
        level: 'check',
        proposals: {
          type_key: { value: 'bank_statement', from: 'folder', cue: null },
          owner_member_id: { value: ruth, from: 'folder', cue: null },
        },
      });
      // Accepted, it keeps where it came from; removed, it is gone.
      await api.acceptBatchItem(token, b.id, agree.id, {});
      await api.removeBatchItem(token, b.id, alone.id);
      const after = await api.batch(token, b.id);
      expect(after.items.find((i) => i.id === agree.id)?.folder).toBe('Rukhsana/Passports');
      expect(after.items.some((i) => i.id === alone.id)).toBe(false);
      await api.removeBatch(token, b.id);
    },
  },
  {
    name: 'the review queue: Accept all Ready files what is Ready now, each as its untouched card would; Undo takes it back into the queue; levels are counted when asked (I3)',
    run: async (api, ctx) => {
      if (!ctx.readBatchItems) return;
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.batch_review).toBe(true);
      const me = await api.me(token);
      const b = await api.createBatch(token, { name: 'All at once', defaults: { tags: ['bulk'] } });
      const file = (n: string) => ({
        kind: 'bytes' as const,
        filename: `${n}.pdf`,
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode(`%PDF-1.4\n% the contract queue ${n}\n%%EOF\n`),
      });
      const ready = await api.addBatchItem(token, b.id, file('ready'));
      const unsure = await api.addBatchItem(token, b.id, file('unsure'));
      const day = (date: string) => ({ date, precision: 'day' as const });
      const passport = (c: number): DetailProposal => ({
        type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
        owner_member_id: { value: me.member_id, confidence: c, cue: 'name_labelled' },
        expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
        identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
      });
      await ctx.readBatchItems(b.id, {
        [ready.id]: { proposal: passport(0.9) },
        [unsure.id]: { proposal: passport(0.6) },
      });
      const listed = (await api.batches(token, { levels: true })).items.find((x) => x.id === b.id);
      expect(listed?.levels).toEqual({
        ready: 1,
        check: 1,
        unrecognised: 0,
        problem: 0,
        unread: 0,
      });
      expect((await api.batches(token)).items.find((x) => x.id === b.id)?.levels).toBeUndefined();

      // The client names both; only what is Ready now is filed.
      const out = await api.acceptReady(token, b.id, { item_ids: [ready.id, unsure.id] });
      expect(out.accepted.map((a) => a.item_id)).toEqual([ready.id]);
      expect(out.skipped).toEqual([{ item_id: unsure.id, reason: 'not_ready', level: 'check' }]);
      expect(out.failed).toEqual([]);
      expect(out.more).toBe(false);
      expect(typeof out.undo_until).toBe('string');
      const filed = await api.document(token, out.accepted[0]?.document_id as string);
      expect(filed).toMatchObject({
        type_key: 'passport',
        owner_member_id: me.member_id,
        identifier: '533401872',
        expires: day('2031-03-14'),
        tags: ['bulk'],
      });

      // Undo: the document is gone, and the item waits again, to be read.
      const back = await api.undoAcceptReady(token, b.id, [ready.id, unsure.id]);
      expect(back.restored).toEqual([ready.id]);
      expect(back.kept.map((k) => [k.item_id, k.reason])).toEqual([[unsure.id, 'not_undoable']]);
      const gone = await refusal(api.document(token, filed.id));
      expect(gone.status).toBe(404);
      expect((await api.batch(token, b.id)).items.find((i) => i.id === ready.id)).toMatchObject({
        state: 'waiting',
        reading: 'waiting',
        document_id: null,
      });
      // Nothing Ready now: nothing filed.
      const none = await api.acceptReady(token, b.id);
      expect(none).toMatchObject({ accepted: [], undo_until: null, more: false });
      await api.removeBatch(token, b.id);
    },
  },
  {
    name: 'learning from corrections: a correction teaches a rule for the issuer, an unchanged accept confirms it and is counted, and forgetting takes both (I4)',
    run: async (api, ctx) => {
      if (!ctx.readBatchItems) return;
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.batch_learning).toBe(true);
      const me = await api.me(token);
      await api.forgetBatchLearning(token);
      expect(await api.batchLearning(token)).toMatchObject({
        counted: 0,
        unchanged: 0,
        window: 50,
        rules: [],
        rules_max: 500,
      });
      const b = await api.createBatch(token, { name: 'Learning' });
      const file = (n: string) => ({
        kind: 'bytes' as const,
        filename: `${n}.pdf`,
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode(`%PDF-1.4\n% the contract learns ${n}\n%%EOF\n`),
      });
      const issuer = { value: 'Northgate Bank', confidence: 0.9, cue: 'letterhead' } as const;
      const first = await api.addBatchItem(token, b.id, file('first'));
      const second = await api.addBatchItem(token, b.id, file('second'));
      await ctx.readBatchItems(b.id, {
        [first.id]: {
          proposal: {
            type_key: { value: 'utility_bill', confidence: 0.9, cue: 'kind_words' },
            issued_by: issuer,
          },
        },
        [second.id]: {
          proposal: {
            type_key: { value: 'bank_statement', confidence: 0.97, cue: 'kind_words' },
            issued_by: issuer,
          },
        },
      });
      // The kind changed, and whose it is filled: both corrections.
      await api.acceptBatchItem(token, b.id, first.id, {
        type_key: 'bank_statement',
        owner_member_id: me.member_id,
        issued_by: 'Northgate Bank PLC',
      });
      const taught = await api.batchLearning(token);
      expect(taught).toMatchObject({ counted: 1, unchanged: 0 });
      expect(
        taught.rules.map((r) => [r.issuer, r.field, r.value, r.confirmed, r.contradicted, r.sure]),
      ).toEqual([
        ['northgate bank', 'type_key', 'bank_statement', 1, 0, false],
        ['northgate bank', 'owner_member_id', me.member_id, 1, 0, false],
      ]);
      expect(taught.rules.every((r) => typeof r.label === 'string')).toBe(true);
      // Accepted as proposed: the rule confirmed, and it needed no change.
      await api.acceptBatchItem(token, b.id, second.id, {
        type_key: 'bank_statement',
        issued_by: 'Northgate Bank',
      });
      const confirmed = await api.batchLearning(token);
      expect(confirmed).toMatchObject({ counted: 2, unchanged: 1 });
      expect(confirmed.rules.find((r) => r.field === 'type_key')).toMatchObject({ confirmed: 2 });
      // Forgotten: the rules and the count.
      await api.forgetBatchLearning(token);
      expect(await api.batchLearning(token)).toMatchObject({ counted: 0, rules: [] });
      await api.removeBatch(token, b.id);
    },
  },
  {
    name: 'the Reading check: an owner starts one, one at a time, cancels and removes it; numbers only (0.9.0, R0)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.reading_check).toBe(true);
      const before = await api.readingChecks(token);
      expect(typeof before.filed).toBe('number');
      // Another owner's checks, without their numbers (R0 review): none here.
      expect(before.others).toEqual([]);
      const c = await api.startReadingCheck(token, { n: 20 });
      expect(c).toMatchObject({
        state: 'waiting',
        n: 20,
        include_edited: true,
        mine: true,
        summary: null,
        failure: null,
        progress: { total: 0, done: 0 },
      });
      // One at a time.
      expect((await refusal(api.startReadingCheck(token))).code).toBe('reading_check_running');
      // From 10 to 500.
      expect((await refusal(api.startReadingCheck(token, { n: 9 }))).status).toBe(422);
      const cancelled = await api.cancelReadingCheck(token, c.id);
      expect(cancelled).toMatchObject({ id: c.id, state: 'cancelled', summary: null });
      expect(cancelled.finished_at).not.toBeNull();
      expect((await refusal(api.cancelReadingCheck(token, c.id))).code).toBe(
        'reading_check_not_running',
      );
      const one = await api.readingCheck(token, c.id);
      expect(one).toMatchObject({ state: 'cancelled', misses: null, misses_until: null });
      expect((await api.readingChecks(token)).items.map((i) => i.id)).toContain(c.id);
      await api.deleteReadingCheck(token, c.id);
      expect((await refusal(api.readingCheck(token, c.id))).status).toBe(404);
    },
  },
  {
    name: 'learning a sender’s papers: three accepts of the same layout make its label for the due date trusted; forgetting takes it (R1)',
    run: async (api, ctx) => {
      if (!ctx.readBatchItems) return;
      const { access_token: token } = await signIn(api, ctx);
      await api.forgetBatchLearning(token);
      expect((await api.batchLearning(token)).shapes ?? []).toEqual([]);
      // A card statement: its Payment due is its Expires. (A bill's due date
      // is a detail of its own since 0.9.0, 0087.)
      const b = await api.createBatch(token, { name: 'Statements' });
      const words = ['account', 'charge', 'date', 'number', 'payment', 'total', 'water', 'your'];
      for (const [n, day] of ['2026-03-20', '2026-04-20', '2026-05-20'].entries()) {
        const it = await api.addBatchItem(token, b.id, {
          kind: 'bytes',
          filename: `statement-${n}.pdf`,
          contentType: 'application/pdf',
          bytes: new TextEncoder().encode(`%PDF-1.4\n% the contract's statement ${n}\n%%EOF\n`),
        });
        await ctx.readBatchItems(b.id, {
          [it.id]: {
            proposal: {
              type_key: { value: 'credit_card_statement', confidence: 0.97, cue: 'kind_words' },
              issued_by: { value: 'Northgate Water', confidence: 0.95, cue: 'letterhead' },
            },
            paper: {
              words,
              dates: [{ label: 'payment date', band: 4, value: { date: day, precision: 'day' } }],
              numbers: [],
            },
          },
        });
        await api.acceptBatchItem(token, b.id, it.id, {
          type_key: 'credit_card_statement',
          issued_by: 'Northgate Water',
          expires: { date: day, precision: 'day' },
        });
      }
      const got = await api.batchLearning(token);
      expect(got.shapes_max).toBe(200);
      expect(
        (got.shapes ?? []).map((s) => [
          s.issuer,
          s.words,
          s.lessons.map((l) => [l.field, l.value, l.confirmed, l.contradicted, l.sure]),
        ]),
      ).toEqual([
        [
          'northgate water',
          words.length,
          [
            ['type_key', 'credit_card_statement', 3, 0, true],
            ['expires', 'payment date', 3, 0, true],
          ],
        ],
      ]);
      await api.forgetBatchLearning(token);
      expect((await api.batchLearning(token)).shapes ?? []).toEqual([]);
      await api.removeBatch(token, b.id);
    },
  },
  {
    name: 'how many of your uploads wait, in one count: the list’s sum, your own alone, an owner’s too; a viewer refused',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      const summed = async (t: string) =>
        (await api.batches(t)).items.reduce((n, b) => n + b.counts.waiting, 0);
      const before = (await api.batchCounts(token)).waiting;
      expect(before).toBe(await summed(token));
      const b = await api.createBatch(token, { name: 'Counted' });
      const file = (n: string) => ({
        kind: 'bytes' as const,
        filename: `${n}.pdf`,
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode(`%PDF-1.4\n% the contract counts ${n}\n%%EOF\n`),
      });
      const one = await api.addBatchItem(token, b.id, file('one'));
      await api.addBatchItem(token, b.id, file('two'));
      expect(await api.batchCounts(token)).toEqual({ waiting: before + 2 });

      // Somebody else who uploads counts their own, and the owner's stays theirs.
      const ada = { email: 'counted-adult@example.test', password: 'the adult’s own password' };
      await ctx.addSignIn(token, { name: 'Ada', role: 'adult', ...ada });
      const adult = await signInAs(api, ada.email, ada.password);
      expect(await api.batchCounts(adult.access_token)).toEqual({ waiting: 0 });
      const theirs = await api.createBatch(adult.access_token, { name: 'Theirs' });
      await api.addBatchItem(adult.access_token, theirs.id, file('theirs'));
      expect(await api.batchCounts(adult.access_token)).toEqual({ waiting: 1 });
      expect(await api.batchCounts(token)).toEqual({ waiting: before + 2 });

      // Removed: no longer waiting.
      await api.removeBatchItem(token, b.id, one.id);
      expect(await api.batchCounts(token)).toEqual({ waiting: before + 1 });
      expect((await api.batchCounts(token)).waiting).toBe(await summed(token));

      const vee = { email: 'counted-viewer@example.test', password: 'the viewer’s own password' };
      await ctx.addSignIn(token, { name: 'Vic', role: 'viewer', ...vee });
      const viewer = await signInAs(api, vee.email, vee.password);
      expect(await refusal(api.batchCounts(viewer.access_token))).toMatchObject({
        status: 403,
        code: 'forbidden',
      });
      await api.removeBatch(token, b.id);
      await api.removeBatch(adult.access_token, theirs.id);
    },
  },
  {
    name: 'inviting family members to sign up: nobody under 13 by their date of birth, somebody 13 today as a teen and never as an adult, somebody 18 never as a teen; a child’s date of birth an owner’s to change; the owners told once somebody turns 13, and the reminder dismissed (after 0.7.0)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      // Somebody else with a sign-in, made first: the real vault's run asks
      // the owner to confirm it is them, which the invitations below ask too.
      const ann = { email: 'ann-thirteen@contract.test', password: 'ann has a long password' };
      await ctx.addSignIn(token, { name: 'Ann', role: 'adult', ...ann });
      // A new vault's calendar: UTC, as each of these is.
      const today = localToday('UTC');
      const [y, m, d] = today.split('-').map(Number) as [number, number, number];
      /** Born `years` before today: the 28th for a 29 February. */
      const born = (years: number, plusDays = 0) => {
        const day = Math.min(d, new Date(Date.UTC(y - years, m, 0)).getUTCDate()) + plusDays;
        return new Date(Date.UTC(y - years, m - 1, day)).toISOString().slice(0, 10);
      };
      const young = await api.addMember(token, {
        display_name: 'Contract Twelve',
        date_of_birth: born(13, 1),
      });
      const tooYoung = await refusal(
        api.invite(token, { member_id: young.id, email: 'twelve@contract.test', role: 'teen' }),
      );
      expect(tooYoung.status).toBe(422);
      expect(tooYoung.code).toBe('too_young');

      const thirteen = await api.addMember(token, {
        display_name: 'Contract Thirteen',
        date_of_birth: born(13),
      });
      expect((await api.personReminders(token)).items).toEqual([]);
      if (ctx.turnThirteen) {
        await ctx.turnThirteen(thirteen.id);
        const told = (await api.personReminders(token)).items;
        expect(told).toEqual([
          {
            id: expect.any(String) as unknown,
            kind: 'turned_13',
            member_id: thirteen.id,
            display_name: 'Contract Thirteen',
            fire_at: today,
            title: 'Contract Thirteen is 13 today',
            label: 'They can now have their own sign-in.',
          },
        ]);
        await api.dismissPersonReminder(token, (told[0] as { id: string }).id);
        expect((await api.personReminders(token)).items).toEqual([]);
      }
      // The role is one their age allows: a teen's at 13, never a teen's at 18.
      const notAdult = await refusal(
        api.invite(token, {
          member_id: thirteen.id,
          email: 'thirteen@contract.test',
          role: 'adult',
        }),
      );
      expect(notAdult.status).toBe(422);
      expect(notAdult.code).toBe('role_not_for_age');
      const grown = await api.addMember(token, {
        display_name: 'Contract Eighteen',
        date_of_birth: born(18),
      });
      const notTeen = await refusal(
        api.invite(token, { member_id: grown.id, email: 'eighteen@contract.test', role: 'teen' }),
      );
      expect(notTeen.status).toBe(422);
      expect(notTeen.code).toBe('role_not_for_age');
      const made = await api.invite(token, {
        member_id: thirteen.id,
        email: 'thirteen@contract.test',
        role: 'teen',
      });
      expect(made.invitation).toMatchObject({
        member_id: thirteen.id,
        display_name: 'Contract Thirteen',
        role: 'teen',
        state: 'pending',
      });
      await api.revokeInvitation(token, made.invitation.id);

      // The reminders are the owners' alone.
      const adult = await signInAs(api, ann.email, ann.password);
      expect((await refusal(api.personReminders(adult.access_token))).status).toBe(403);
      // A child's date of birth is an owner's to change or clear (the review,
      // INV-6): an adult may not, so may not make them old enough to invite.
      const cleared = await refusal(
        api.updateMember(adult.access_token, young.id, { date_of_birth: null }),
      );
      expect(cleared.status).toBe(403);
      expect(cleared.code).toBe('child_birthday_owners');
      expect(
        (await api.updateMember(token, young.id, { date_of_birth: null })).date_of_birth,
      ).toBeNull();
    },
  },
  {
    name: 'a computer is paired with a one-time code, sends a scan with its key into its person’s uploads, is refused everything else, and is revoked (0.8.0, D1)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.device_uploads).toBe(true);
      const pairing = await api.createDevicePairing(token);
      expect(pairing.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(Date.parse(pairing.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
      const wrong = await refusal(
        api.pairDevice({ code: 'AAAA-AAAA', device_name: 'Laptop', platform: 'windows' }),
      );
      expect(wrong).toMatchObject({ status: 401, code: 'pairing_code_invalid' });
      // Typed as a person types it: lower case, the dash or not.
      const paired = await api.pairDevice({
        code: pairing.code.toLowerCase().replace('-', ''),
        device_name: '  Contract   laptop ',
        platform: 'windows',
      });
      expect(paired.key.length).toBeGreaterThanOrEqual(43);
      const device = { device_id: paired.device_id, key: paired.key };
      const about = await api.deviceMe(device);
      expect(about).toMatchObject({
        device_id: paired.device_id,
        device_name: 'Contract laptop',
        active: true,
        paused: null,
      });
      // Its day starts again at the next midnight, within a day.
      const resets = Date.parse(about.limits.day_resets_at) - Date.now();
      expect(resets).toBeGreaterThan(0);
      expect(resets).toBeLessThanOrEqual(25 * 3_600_000);
      // A code closed before it is used is ended.
      const closed = await api.createDevicePairing(token);
      await api.endDevicePairing(token);
      const ended = await refusal(
        api.pairDevice({ code: closed.code, device_name: 'Closed', platform: 'linux' }),
      );
      expect(ended.code).toBe('pairing_code_invalid');
      // A code is used once.
      const again = await refusal(
        api.pairDevice({ code: pairing.code, device_name: 'Another', platform: 'macos' }),
      );
      expect(again.code).toBe('pairing_code_invalid');
      const key = '0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';
      const scan = {
        kind: 'bytes' as const,
        filename: 'scan.pdf',
        contentType: 'application/pdf',
        bytes: PDF,
      };
      const sent = await api.deviceUpload(device, scan, key, { relativePath: 'Bills/scan.pdf' });
      expect(sent).toEqual({ item_id: expect.any(String) as unknown, status: 'waiting' });
      // Sent again after its answer was lost: the item it made.
      expect(await api.deviceUpload(device, scan, key)).toEqual(sent);
      // Into its person's own uploads, a batch for the day.
      const day = (await api.batches(token)).items.find((b) =>
        (b.name ?? '').startsWith('From Contract laptop, '),
      );
      expect(day?.counts.waiting).toBe(1);
      // Its key opens nothing else.
      const elsewhere = await refusal(
        api.http.request('/api/v1/batches', { headers: deviceHeaders(device) }),
      );
      expect(elsewhere.status).toBe(401);
      expect(
        (await api.listDevices(token)).items.find((d) => d.id === paired.device_id),
      ).toMatchObject({ name: 'Contract laptop', platform: 'windows', mine: true });
      await api.revokeDevice(token, paired.device_id);
      expect((await refusal(api.deviceMe(device))).code).toBe('device_revoked');
      expect((await refusal(api.deviceUpload(device, scan, NEVER_USED))).code).toBe(
        'device_revoked',
      );
      expect((await api.listDevices(token)).items.some((d) => d.id === paired.device_id)).toBe(
        false,
      );
    },
  },
  {
    name: 'tags you can use: a detail tag kept as label: value, filtered by its label and whatever its case; a tag renamed, merged after asking, and deleted (0.9.0, T1)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      const features = (await api.capabilities()).features;
      expect(features.tag_details).toBe(true);
      expect(features.tag_management).toBe(true);
      const me = await api.me(token);
      const a = await api.createDocument(token, {
        title: 'Contract gym pass',
        owner_member_id: me.member_id,
        tags: ['Contract Locker :  C-12', 'contract agent: Sam Lee', 'Contract-Plain'],
      });
      expect(a.tags).toEqual([
        'contract locker: C-12',
        'contract agent: Sam Lee',
        'contract-plain',
      ]);
      const b = await api.createDocument(token, {
        title: 'Contract pool pass',
        owner_member_id: me.member_id,
        tags: ['contract locker: C-7', 'contract-other'],
      });
      // Too long, in words.
      const long = await refusal(
        api.createDocument(token, { title: 'Too long', tags: ['x'.repeat(41)] }),
      );
      expect(long.status).toBe(422);
      expect(long.message).toMatch(/^A tag can be 40 characters at most/);

      const titles = async (params: Record<string, string>) =>
        (await api.documents(token, { sort: 'title', ...params })).items.map((d) => d.title);
      expect(await titles({ tag_label: 'Contract Locker' })).toEqual([
        'Contract gym pass',
        'Contract pool pass',
      ]);
      expect(await titles({ tag: 'CONTRACT AGENT: sam lee' })).toEqual(['Contract gym pass']);
      expect(await titles({ tag_label: 'contract locker', tag: 'contract locker: c-7' })).toEqual([
        'Contract pool pass',
      ]);

      const listed = await api.tags(token, 'contract locker: ', { limit: 1000 });
      expect(listed.items).toEqual([
        {
          tag: 'contract locker: C-12',
          count: 1,
          label: 'contract locker',
          value: 'C-12',
          changeable: 1,
        },
        {
          tag: 'contract locker: C-7',
          count: 1,
          label: 'contract locker',
          value: 'C-7',
          changeable: 1,
        },
      ]);

      // A merge is asked about first; asked, the two are one.
      const asked = await refusal(
        api.renameTag(token, { from: 'contract-plain', to: 'Contract-Other' }),
      );
      expect(asked.status).toBe(409);
      expect(asked.code).toBe('tag_exists');
      expect((await api.document(token, a.id)).tags).toContain('contract-plain');
      expect(
        await api.renameTag(token, { from: 'contract-plain', to: 'contract-other', merge: true }),
      ).toEqual({ changed: 1, kept: 0, merged: true, in_trash: 0 });
      expect((await api.document(token, a.id)).tags).toEqual([
        'contract locker: C-12',
        'contract agent: Sam Lee',
        'contract-other',
      ]);
      // Renamed: an edit against the document as it was is told so.
      const stale = await refusal(api.updateDocument(token, a.id, { title: 'x' }, a.etag));
      expect(stale.status).toBe(409);
      // An edit of its tags with its ETag, as the document page makes it.
      const now = await api.document(token, b.id);
      const tagged = await api.updateDocument(
        token,
        b.id,
        { tags: [...now.tags, 'Contract note: Blue folder'] },
        now.etag,
      );
      expect(tagged.tags).toEqual([
        'contract locker: C-7',
        'contract-other',
        'contract note: Blue folder',
      ]);

      expect(await api.deleteTag(token, 'Contract-Other')).toEqual({
        changed: 2,
        kept: 0,
        merged: false,
        in_trash: 0,
      });
      expect((await api.document(token, b.id)).tags).toEqual([
        'contract locker: C-7',
        'contract note: Blue folder',
      ]);
      const viewerless = await refusal(api.renameTag(token, { from: ' ', to: 'x' }));
      expect(viewerless.status).toBe(422);
      await api.deleteDocument(token, a.id);
      await api.deleteDocument(token, b.id);
    },
  },
  {
    name: 'a collection from a checklist: read, matched, added as ticked, kept and matched again (0.9.0, C1)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.collection_checklist).toBe(true);
      const me = await api.me(token);
      const kinds = (await api.documentTypes(token)).items.map((t) => t.key);
      expect(kinds).toEqual(expect.arrayContaining(['pay_statement', 'investment_statement']));
      const slip = (title: string, date: string) =>
        api.createDocument(token, {
          title,
          type_key: 'pay_statement',
          owner_member_id: me.member_id,
          visibility: 'adults',
          issued: { date, precision: 'day' },
        });
      const jul = await slip('Contract payslip July', '2026-07-31');
      const aug = await slip('Contract payslip August', '2026-08-31');
      const sep = await slip('Contract payslip September', '2026-09-30');
      const made = await api.createCollection(token, {
        name: 'Contract refinance',
        audience: 'everyone',
      });
      const read = await api.checkChecklist(token, made.id, {
        text: 'Documents for me\nLast 2 pay statements\nLast 2 contract widgets',
      });
      expect(read.saved_at).toBeNull();
      expect(read.mine).toBe(true);
      expect(read.items.map((i) => [i.type_key, i.member_id, i.count, i.understood])).toEqual([
        ['pay_statement', me.member_id, 2, true],
        [null, me.member_id, 2, false],
      ]);
      const first = read.items[0];
      expect(first?.matches.filter((m) => m.ticked).map((m) => m.document_id)).toEqual([
        sep.id,
        aug.id,
      ]);
      expect(first?.matches.find((m) => m.document_id === jul.id)?.ticked).toBe(false);
      expect(first).toMatchObject({ wanted: 2, found: 2, missing: [] });
      expect(read.to_add).toBe(2);
      // Nothing is put in until it is asked for, and then only what is ticked.
      expect((await api.getCollection(token, made.id)).item_count).toBe(0);
      const added = await api.addFromChecklist(token, made.id, [sep.id, aug.id, sep.id]);
      expect(added.added.sort()).toEqual([aug.id, sep.id].sort());
      expect(added.skipped).toEqual([]);
      expect(added.collection.item_count).toBe(2);
      const again = await api.addFromChecklist(token, made.id, [sep.id]);
      expect(again).toMatchObject({
        added: [],
        skipped: [{ document_id: sep.id, why: 'in_collection' }],
      });
      // Kept, and matched again as it is opened: none left to add.
      const kept = await api.saveChecklist(token, made.id, read.items);
      expect(kept.saved_at).not.toBeNull();
      const opened = await api.collectionChecklist(token, made.id);
      expect(opened.items.map((i) => i.line)).toEqual([
        'Last 2 pay statements',
        'Last 2 contract widgets',
      ]);
      expect(opened.to_add).toBe(0);
      // A list longer than it reads is refused before it is read.
      const long = await refusal(api.checkChecklist(token, made.id, { text: 'x'.repeat(10_001) }));
      expect(long.status).toBe(422);
      await api.deleteCollection(token, made.id);
      for (const d of [jul, aug, sep]) await api.deleteDocument(token, d.id);
    },
  },
  {
    name: 'a note kept on its own: made, listed with its preview, found, changed one editor at a time, and never given a file (0.9.0, N1)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.notes).toBe(true);
      const me = await api.me(token);
      const made = await api.createDocument(token, {
        type_key: 'note',
        title: 'Contract boiler',
        owner_member_id: me.member_id,
        visibility: 'household',
        notes: '# Boiler\nRing **Ann** first',
      });
      expect(made.type_key).toBe('note');
      expect((await api.versions(token, made.id)).items).toEqual([]);
      const listed = (await api.notes(token)).items.find((n) => n.id === made.id);
      expect(listed).toMatchObject({ title: 'Contract boiler', preview: 'Boiler Ring Ann first' });
      expect((await api.notes(token, { q: 'ann first' })).items.map((n) => n.id)).toEqual([
        made.id,
      ]);
      expect((await api.notes(token, { q: 'no such words anywhere' })).items).toEqual([]);
      // Its kind is listed once a note uses it, for a client to look it up.
      expect((await api.documentTypes(token)).items.find((t) => t.key === 'note')).toMatchObject({
        label: 'Note',
        hidden: true,
      });
      // One editor at a time: a save from the copy before is refused, with the note now.
      const saved = await api.updateDocument(token, made.id, { notes: 'Ring Bob' }, made.etag);
      expect(saved.notes).toBe('Ring Bob');
      const stale = await refusal(
        api.updateDocument(token, made.id, { notes: 'Ring Cal' }, made.etag),
      );
      expect(stale.status).toBe(409);
      expect((JSON.parse(stale.detail ?? '{}') as { notes?: string }).notes).toBe('Ring Bob');
      // No file, whatever would give it one; and it stays a note.
      const form = multipartBody([
        { name: 'file', filename: 'scan.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      const body = { kind: 'bytes' as const, bytes: form.bytes, contentType: form.contentType };
      const upload = await refusal(
        api.upload(token, made.id, body, '7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a0f'),
      );
      expect([upload.status, upload.code]).toEqual([422, 'note_has_no_file']);
      const kind = await refusal(api.updateDocument(token, made.id, { type_key: 'warranty' }));
      expect([kind.status, kind.code]).toEqual([422, 'note_kind_fixed']);
      // To the Trash: listed there, not in the notes.
      await api.deleteDocument(token, made.id);
      expect((await api.notes(token)).items.map((n) => n.id)).not.toContain(made.id);
      expect((await api.notes(token, { deleted: 'true' })).items.map((n) => n.id)).toContain(
        made.id,
      );
    },
  },
  {
    name: "the family's time zone: the server's default until an owner chooses one, cleared back by null, a name nobody knows refused (0.9.0, TZ)",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const first = await api.householdTimezone(token);
      expect(first).toMatchObject({ timezone_source: 'server_default', can_change: true });
      expect(first.timezone).toBe(first.server_timezone);
      const chosen = await api.setHouseholdTimezone(token, 'Pacific/Kiritimati');
      expect(chosen).toMatchObject({
        timezone: 'Pacific/Kiritimati',
        timezone_source: 'household',
        server_timezone: first.server_timezone,
      });
      expect(await api.householdTimezone(token)).toEqual(chosen);
      const unknown = await refusal(api.setHouseholdTimezone(token, 'Mars/Olympus_Mons'));
      expect([unknown.status, unknown.code]).toEqual([422, 'validation_failed']);
      // An abbreviation or an offset is not a zone; a name is kept as it is spelt.
      for (const not of ['EST', '+05:30']) {
        expect((await refusal(api.setHouseholdTimezone(token, not))).status).toBe(422);
      }
      expect((await api.setHouseholdTimezone(token, 'europe/london')).timezone).toBe(
        'Europe/London',
      );
      await api.setHouseholdTimezone(token, 'Pacific/Kiritimati');
      expect((await api.householdTimezone(token)).timezone).toBe('Pacific/Kiritimati');
      const cleared = await api.setHouseholdTimezone(token, null);
      expect(cleared).toEqual(first);
    },
  },
  {
    name: 'ended links and requests: kept 90 days unless an owner chose otherwise, 30, 365 or never, anything else refused (0.9.0, RQ)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.ended_sharing).toBe(true);
      expect(await api.endedSharing(token)).toEqual({ remove_after_days: 90, can_change: true });
      expect(await api.setEndedSharing(token, 30)).toEqual({
        remove_after_days: 30,
        can_change: true,
      });
      expect((await api.setEndedSharing(token, null)).remove_after_days).toBeNull();
      expect((await api.endedSharing(token)).remove_after_days).toBeNull();
      const odd = await refusal(api.setEndedSharing(token, 45 as never));
      expect([odd.status, odd.code]).toEqual([422, 'validation_failed']);
      expect((await api.setEndedSharing(token, 90)).remove_after_days).toBe(90);
    },
  },
  {
    name: "one document's activity: its own lines, as the whole log says them, and 404 for one that is not there (0.9.0, DA)",
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      expect((await api.capabilities()).features.document_activity).toBe(true);
      const doc = await api.createDocument(token, {
        title: 'Contract activity passport',
        sensitive: false,
      });
      const other = await api.createDocument(token, {
        title: 'Contract activity other',
        sensitive: false,
      });
      const page = await api.documentActivity(token, doc.id);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((l) => l.document_id === doc.id)).toBe(true);
      expect(page.items.some((l) => l.text.endsWith('added “Contract activity passport”'))).toBe(
        true,
      );
      // The same line, word for word, as the whole log has it.
      const whole = (await api.activity(token)).items.filter((l) => l.document_id === doc.id);
      expect(page.items.map((l) => l.text)).toEqual(whole.map((l) => l.text));
      expect(page.items.some((l) => l.document_id === other.id)).toBe(false);
      const missing = await refusal(
        api.documentActivity(token, '00000000-0000-4000-8000-000000000000'),
      );
      expect([missing.status, missing.code]).toEqual([404, 'not_found']);
    },
  },
  {
    name: 'the activity log as CSV: the lines the log gives, through its filters, named for the vault and the day; 404 for a document not there, 422 for a filter that is not one (0.9.0-dev.82)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.activity_export).toBe(true);
      const doc = await api.createDocument(token, {
        title: 'Contract csv bill, the first',
        sensitive: false,
      });
      // Its lines as its activity says them, before the download is one of them.
      const said = (await api.documentActivity(token, doc.id)).items.map((l) => l.text);
      const res = await api.activityCsv(token, { document: doc.id });
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toMatch(
        /^attachment; filename\*=UTF-8''activity-vault-\d{4}-\d{2}-\d{2}\.csv$/,
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      // UTF-8 with a byte-order mark, rows ending CRLF.
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes.slice(3));
      const rows = text.split('\r\n');
      expect(rows[0]).toBe(ACTIVITY_CSV_COLUMNS.join(','));
      // A comma in a title is quoted, and the line is the log's.
      expect(text).toContain('added “Contract csv bill, the first”"');
      expect(said.length).toBeGreaterThan(0);
      expect(said.every((t) => text.includes(t))).toBe(true);
      // And the download itself is a line about the document now.
      expect(
        (await api.documentActivity(token, doc.id)).items.some((l) =>
          l.text.endsWith(
            'downloaded the activity of “Contract csv bill, the first” as a spreadsheet',
          ),
        ),
      ).toBe(true);
      expect(activityCsvCapped(text)).toBe(false);
      // A filter that keeps none of them: the columns alone.
      const none = await api.activityCsv(token, { document: doc.id, kind: 'shared' });
      expect(new TextDecoder().decode(new Uint8Array(await none.arrayBuffer()).slice(3))).toBe(
        `${ACTIVITY_CSV_COLUMNS.join(',')}\r\n`,
      );
      const missing = await refusal(api.activityCsv(token, { document: NEVER_USED }));
      expect([missing.status, missing.code]).toEqual([404, 'not_found']);
      const odd = await refusal(api.activityCsv(token, { kind: 'everything' }));
      expect([odd.status, odd.code]).toEqual([422, 'validation_failed']);
    },
  },
  {
    name: 'filters of several choices: any within one, all across them, each given once or comma-separated; collections, details and the activity export too (0.9.0-dev.92)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.multi_filters).toBe(true);
      const me = await api.me(token);
      const paper = (title: string, type_key: string, tags: string[]) =>
        api.createDocument(token, {
          type_key,
          owner_member_id: me.member_id,
          visibility: 'household',
          sensitive: false,
          title,
          tags,
        });
      const passport = await paper('Contract multi passport', 'passport', ['Shelf, top: 1']);
      const licence = await paper('Contract multi certificate', 'birth_certificate', ['Drawer: 2']);
      const will = await paper('Contract multi bill', 'utility_bill', []);
      const box = await api.createCollection(token, {
        name: 'Contract multi box',
        audience: 'everyone',
      });
      await api.addToCollection(token, box.id, [passport.id]);
      const ids = async (params: DocumentListParams) =>
        (await api.documents(token, { sort: 'title', limit: 200, ...params })).items
          .map((d) => d.id)
          .filter((id) => [passport.id, licence.id, will.id].includes(id))
          .sort();
      const sorted = (...docs: Array<{ id: string }>) => docs.map((d) => d.id).sort();
      // Within one filter, any of them: given once each, or comma-separated.
      expect(await ids({ type_key: ['passport', 'birth_certificate'] })).toEqual(
        sorted(passport, licence),
      );
      expect(await ids({ type_key: 'passport,birth_certificate' })).toEqual(
        sorted(passport, licence),
      );
      // One value, as it always was.
      expect(await ids({ type_key: 'utility_bill' })).toEqual(sorted(will));
      // Across filters, all of them.
      expect(
        await ids({ type_key: ['passport', 'birth_certificate'], member_id: [me.member_id] }),
      ).toEqual(sorted(passport, licence));
      expect(
        await ids({ type_key: ['passport', 'utility_bill'], collection_id: [box.id, 'none'] }),
      ).toEqual(sorted(passport, will));
      // A detail's label holding a comma, given once: never split.
      expect(await ids({ tag_label: ['Shelf, top', 'drawer'] })).toEqual(sorted(passport, licence));
      const wrong = await refusal(
        api.documents(token, { sort: 'title', collection_id: [box.id, 'holiday'] }),
      );
      expect([wrong.status, wrong.code]).toEqual([422, 'validation_failed']);
      // The activity export takes several who and kinds.
      const csv = await api.activityCsv(token, {
        who: [me.member_id, 'else'],
        kind: ['added', 'changed'],
      });
      expect(csv.status).toBe(200);
      const odd = await refusal(api.activityCsv(token, { kind: ['added', 'everything'] }));
      expect([odd.status, odd.code]).toEqual([422, 'validation_failed']);
      await api.deleteCollection(token, box.id);
      for (const d of [passport, licence, will]) await api.deleteDocument(token, d.id);
    },
  },
  {
    name: 'a locked session answers 423 session_locked, but for who it is, until the password unlocks it; another session goes on, and a renewal stays locked (0.9.0-dev.86)',
    run: async (api, ctx) => {
      expect((await api.capabilities()).features.session_lock).toBe(true);
      const mine = await signIn(api, ctx);
      const other = (ctx.tokens as Tokens).access_token;
      await api.lock(mine.access_token);
      // Locked already: the same.
      await api.lock(mine.access_token);
      const refused = await refusal(api.documents(mine.access_token));
      expect([refused.status, refused.code]).toEqual([423, SESSION_LOCKED_CODE]);
      expect(isSessionLocked(refused)).toBe(true);
      expect(isSessionOver(refused)).toBe(false);
      expect((await api.me(mine.access_token)).locked).toBe(true);
      // Another session of the same person is not locked.
      expect((await api.me(other)).locked).toBe(false);
      expect(Array.isArray((await api.documents(other)).items)).toBe(true);
      // A renewal names the same session: as locked.
      const renewed = await api.refresh(mine.refresh_token);
      expect((await refusal(api.documents(renewed.access_token))).status).toBe(423);
      const wrong = await refusal(api.unlock(renewed.access_token, { password: 'not the one' }));
      expect([wrong.status, wrong.code]).toEqual([401, 'invalid_credentials']);
      await api.unlock(renewed.access_token, { password: ctx.password });
      expect((await api.me(renewed.access_token)).locked).toBe(false);
      expect(Array.isArray((await api.documents(renewed.access_token)).items)).toBe(true);
      await api.logout(renewed.access_token);
    },
  },
  {
    name: 'the vault locks itself after a while away: 15 minutes for the family unless an owner chose otherwise, anybody a shorter time of their own, never longer (0.9.0-dev.87)',
    run: async (api, ctx) => {
      expect((await api.capabilities()).features.auto_lock).toBe(true);
      // A fresh sign-in: a longer time asks to confirm it's you, as it was given.
      const { access_token: token } = await signIn(api, ctx);
      expect(await api.autoLock(token)).toEqual({
        household: 15,
        mine: null,
        in_effect: 15,
        can_change: true,
      });
      // Not a browser's session: never locked by itself, nor told a time.
      expect((await api.me(token)).auto_lock_minutes ?? null).toBeNull();
      expect(await api.setMyAutoLock(token, 5)).toMatchObject({ mine: 5, in_effect: 5 });
      const longer = await refusal(api.setMyAutoLock(token, 30));
      expect([longer.status, longer.code, longer.detail]).toEqual([
        422,
        'validation_failed',
        'minutes',
      ]);
      expect(await api.setHouseholdAutoLock(token, 10)).toMatchObject({
        household: 10,
        mine: 5,
        in_effect: 5,
      });
      expect(await api.setMyAutoLock(token, null)).toMatchObject({ mine: null, in_effect: 10 });
      // Off for the family: anybody may still choose a time for themselves.
      expect(await api.setHouseholdAutoLock(token, null)).toMatchObject({
        household: null,
        in_effect: null,
      });
      expect((await api.setMyAutoLock(token, 60)).in_effect).toBe(60);
      await api.setMyAutoLock(token, null);
      const odd = await refusal(api.setHouseholdAutoLock(token, 20 as never));
      expect([odd.status, odd.code]).toEqual([422, 'validation_failed']);
      expect((await api.setHouseholdAutoLock(token, 15)).household).toBe(15);
      // Somebody still here: a browser's word, nothing more.
      await api.stillHere(token);
      await api.logout(token);
    },
  },
  {
    name: 'password rules an owner sets: 10 characters and common passwords refused unless one chose otherwise, every sign-in password set held to them, and a refusal that says everything missing',
    run: async (api, ctx) => {
      expect((await api.capabilities()).features.password_rules).toBe(true);
      // A fresh sign-in: looser rules ask to confirm it's you, as it was given.
      const { access_token: token } = await signIn(api, ctx);
      expect(await api.passwordRules(token)).toEqual({
        ...PASSWORD_RULES_DEFAULT,
        can_change: true,
      });
      const odd = await refusal(
        api.setPasswordRules(token, { ...PASSWORD_RULES_DEFAULT, min_length: 9 }),
      );
      expect([odd.status, odd.code]).toEqual([422, 'validation_failed']);
      const stricter = { ...PASSWORD_RULES_DEFAULT, min_length: 12, needs_number: true };
      expect(await api.setPasswordRules(token, stricter)).toEqual({
        ...stricter,
        can_change: true,
      });
      // An invitation accepted is held to them, and told what is missing.
      const person = await api.addMember(token, { display_name: 'Contract Rules' });
      const made = await api.invite(token, {
        member_id: person.id,
        email: 'rules@contract.test',
        role: 'adult',
      });
      const short = await refusal(
        api.acceptInvitationLink(made.link_token, { code: made.code, password: 'short one' }),
      );
      expect([short.status, short.code, short.message]).toEqual([
        400,
        'password_rules',
        'Use at least 12 characters, with a number.',
      ]);
      const noNumber = await refusal(
        api.acceptInvitationLink(made.link_token, {
          code: made.code,
          password: 'no digits in this one',
        }),
      );
      expect([noNumber.status, noNumber.code, noNumber.message]).toEqual([
        400,
        'password_rules',
        'Add a number.',
      ]);
      const common = await refusal(
        api.acceptInvitationLink(made.link_token, { code: made.code, password: 'password1234' }),
      );
      expect([common.status, common.code, common.message]).toEqual([
        400,
        'password_rules',
        'That password is too common: choose another.',
      ]);
      const joined = await api.acceptInvitationLink(made.link_token, {
        code: made.code,
        password: 'twelve or more 4 sure',
      });
      expect(joined.role).toBe('adult');
      // Back as every household starts: looser, so asked of a fresh sign-in.
      expect(await api.setPasswordRules(token, PASSWORD_RULES_DEFAULT)).toEqual({
        ...PASSWORD_RULES_DEFAULT,
        can_change: true,
      });
      await api.logout(token);
    },
  },
  {
    name: 'an Only me or an Essential note is listed by its title and date alone, never found by its words, and read with them once it is confirmed to be you (0.9.0-dev.87)',
    run: async (api, ctx) => {
      // Said so from 0.9.0-dev.88: what a phone asks by before it offers the switches.
      expect((await api.capabilities()).features.notes_confirm).toBe(true);
      // A fresh sign-in has confirmed it's them for the next five minutes.
      const { access_token: token } = await signIn(api, ctx);
      const me = await api.me(token);
      const essential = await api.createDocument(token, {
        type_key: 'note',
        title: 'Contract safe',
        owner_member_id: me.member_id,
        visibility: 'household',
        is_essential: true,
        notes: 'The code is behind the clock',
      });
      const mine = await api.createDocument(token, {
        type_key: 'note',
        title: 'Contract diary',
        owner_member_id: me.member_id,
        visibility: 'private',
        notes: 'Pelican crossing at noon',
      });
      const listed = (await api.notes(token)).items;
      expect(listed.find((n) => n.id === essential.id)).toMatchObject({
        title: 'Contract safe',
        preview: '',
        is_essential: true,
        confirm_to_read: 'open_essential',
      });
      expect(listed.find((n) => n.id === mine.id)).toMatchObject({
        preview: '',
        confirm_to_read: 'open_private_document',
      });
      expect((await api.notes(token, { q: 'behind the clock' })).items).toEqual([]);
      expect((await api.notes(token, { q: 'pelican' })).items).toEqual([]);
      // By its title, as ever.
      expect((await api.notes(token, { q: 'contract safe' })).items.map((n) => n.id)).toEqual([
        essential.id,
      ]);
      // Read and saved with its words, as this session confirmed it's them.
      const read = await api.document(token, essential.id);
      expect(read.notes).toBe('The code is behind the clock');
      expect(read.confirm_to_read).toBeUndefined();
      const saved = await api.updateDocument(token, mine.id, { notes: 'Pelican at one' });
      expect(saved.notes).toBe('Pelican at one');
      // A phone keeps them with a grant; with none, nothing.
      expect((await api.offlineEssentials(token)).notes ?? []).toEqual([]);
      await api.deleteDocument(token, essential.id);
      await api.deleteDocument(token, mine.id);
      await api.logout(token);
    },
  },
  {
    name: 'a document no longer needed: kept and listed, said so, reminded of nothing, replaced by one the reader sees, and needed again (0.9.0)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const me = await api.me(token);
      const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
      // A passport for the contract's purpose: a kind every vault, and the fake, has.
      const ead = await api.createDocument(token, {
        type_key: 'passport',
        title: 'Contract EAD card',
        owner_member_id: me.member_id,
        identifier: 'EAD-0001',
        expires: { date: soon, precision: 'day' },
      });
      expect(ead.status.value).toBe('expiring_soon');
      expect(ead.no_longer_needed ?? null).toBeNull();
      const green = await api.createDocument(token, {
        type_key: 'passport',
        title: 'Contract green card',
        owner_member_id: me.member_id,
        identifier: 'GC-0001',
      });
      const marked = await api.markNoLongerNeeded(token, ead.id, {
        reason: '  The green card came  ',
        replaced_by: green.id,
      });
      expect(marked.status).toEqual({ value: 'no_longer_needed', label: 'No longer needed' });
      expect(marked.no_longer_needed).toMatchObject({
        reason: 'The green card came',
        has_reason: true,
        replaced_by: { id: green.id, title: 'Contract green card' },
      });
      expect(marked.etag).not.toBe(ead.etag);
      // Asked again with nothing: both kept; a field left out is never wiped.
      expect((await api.markNoLongerNeeded(token, ead.id, {})).no_longer_needed).toMatchObject({
        reason: 'The green card came',
        replaced_by: { id: green.id },
      });
      // Nothing reminds of it, and the lists say what it is.
      const reminders = await api.reminders(token);
      expect(reminders.items.filter((r) => r.document_id === ead.id)).toEqual([]);
      const ids = async (status: string) =>
        (await api.documents(token, { status })).items.map((d) => d.id);
      expect(await ids('no_longer_needed')).toContain(ead.id);
      expect(await ids('expiring_soon')).not.toContain(ead.id);
      // Kept, and read as it always was.
      expect((await api.document(token, ead.id)).identifier).toBe('EAD-0001');
      // Not by itself, nor by what is not there, nor at any length.
      for (const [body, detail] of [
        [{ replaced_by: ead.id }, 'replaced_by'],
        [{ replaced_by: '00000000-0000-4000-8000-000000000000' }, 'replaced_by'],
        [{ reason: 'x'.repeat(201) }, 'reason'],
      ] as const) {
        const refused = await refusal(api.markNoLongerNeeded(token, ead.id, body));
        expect([refused.status, refused.code, refused.detail]).toEqual([
          422,
          'validation_failed',
          detail,
        ]);
      }
      // Needed again: its expiry speaks again.
      const again = await api.markNeededAgain(token, ead.id);
      expect(again.no_longer_needed ?? null).toBeNull();
      expect(again.status.value).toBe('expiring_soon');
      expect(await ids('no_longer_needed')).not.toContain(ead.id);
    },
  },
  {
    name: 'a new version’s details used as a renewal: only on the document as last seen, only for its newest version, and taken back (0.9.0)',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const doc = await api.createDocument(token, {
        type_key: 'passport',
        title: 'Contract renewed passport',
        expires: { date: '2025-03-01', precision: 'day' },
        identifier: 'OLD-0001',
      });
      const file = () => {
        const form = multipartBody([
          { name: 'file', filename: 'scan.pdf', contentType: 'application/pdf', bytes: PDF },
        ]);
        return { kind: 'bytes' as const, bytes: form.bytes, contentType: form.contentType };
      };
      const first = await api.upload(token, doc.id, file(), '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b');
      const second = await api.upload(
        token,
        doc.id,
        file(),
        '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c',
      );
      const seen = await api.document(token, doc.id);
      // Changed since it was seen: an edit, as anybody's.
      const now = await api.updateDocument(
        token,
        doc.id,
        { title: 'Contract renewed passport, 2025' },
        seen.etag,
      );
      const body = {
        version_id: second.id,
        expires: { date: '2035-03-01', precision: 'day' as const },
        identifier: 'NEW-0002',
      };
      // Not the newest version, or a document changed since: nothing saved.
      const older = await refusal(
        api.applyRenewal(token, doc.id, { ...body, version_id: first.id }, now.etag),
      );
      expect([older.status, older.code]).toEqual([409, 'version_changed']);
      const stale = await refusal(api.applyRenewal(token, doc.id, body, seen.etag));
      expect([stale.status, stale.code]).toEqual([409, 'conflict']);
      expect((await api.document(token, doc.id)).identifier).toBe('OLD-0001');
      // Used: the document's now, with until when it can be taken back.
      const used = await api.applyRenewal(token, doc.id, body, now.etag);
      expect(used.document.expires).toEqual({ date: '2035-03-01', precision: 'day' });
      expect(used.document.identifier).toBe('NEW-0002');
      expect(Date.parse(used.undo_until ?? '')).toBeGreaterThan(Date.now());
      // Taken back: as it was.
      const back = await api.undoRenewal(token, doc.id, second.id);
      expect(back.expires).toEqual({ date: '2025-03-01', precision: 'day' });
      expect(back.identifier).toBe('OLD-0001');
      const twice = await refusal(api.undoRenewal(token, doc.id, second.id));
      expect([twice.status, twice.code]).toEqual([409, 'renewal_not_undoable']);
    },
  },
  {
    name: 'the household as a document’s owner: a household’s kind is the household’s, an older edit keeps it, only Not sure yet needs a person, and the table finds each (0.9.0)',
    run: async (api, ctx) => {
      const { access_token: token, member_id: me } = await signIn(api, ctx);
      if ((await api.capabilities()).features.household_owner !== true) return;
      const kinds = (await api.documentTypes(token, { all: true })).items;
      expect(kinds.find((k) => k.key === 'utility_bill')?.belongs_to).toBe('household');
      expect(kinds.find((k) => k.key === 'passport')?.belongs_to).toBe('person');
      const TAG = 'household-owner';
      let bill = await api.createDocument(token, {
        title: 'Contract household bill',
        type_key: 'utility_bill',
        tags: [TAG],
      });
      expect(bill).toMatchObject({ owner_member_id: null, household_owned: true });
      expect(bill.status.label).not.toBe('Needs a person');
      // What an older phone sends when it saves the card: the person, null.
      bill = await api.updateDocument(token, bill.id, { owner_member_id: null }, bill.etag);
      expect(bill.household_owned).toBe(true);
      const unsure = await api.createDocument(token, {
        title: 'Contract unsure passport',
        type_key: 'passport',
        tags: [TAG],
      });
      expect(unsure).toMatchObject({ household_owned: false });
      expect(unsure.status.label).toBe('Needs a person');
      const mine = await api.createDocument(token, {
        title: 'Contract my passport',
        type_key: 'passport',
        owner_member_id: me,
        household_owned: false,
        tags: [TAG],
      });
      const titles = async (member: string) =>
        (await api.documents(token, { sort: 'title', tag: TAG, member_id: member })).items.map(
          (d) => d.title,
        );
      expect(await titles('household')).toEqual(['Contract household bill']);
      expect(await titles('none')).toEqual(['Contract unsure passport']);
      expect(await titles(`household,${me}`)).toEqual([
        'Contract household bill',
        'Contract my passport',
      ]);
      // The household's, then a person: theirs, and no longer the household's.
      bill = await api.updateDocument(token, bill.id, { owner_member_id: me }, bill.etag);
      expect(bill).toMatchObject({ owner_member_id: me, household_owned: false });
      const both = await refusal(
        api.updateDocument(token, mine.id, { owner_member_id: me, household_owned: true }),
      );
      expect([both.status, both.code]).toEqual([422, 'validation_failed']);
    },
  },
  {
    name: 'Sensitive: a kind’s default, a document’s own choice, an older edit keeps it, and the table filters by it (0.9.0, AIR2)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      if ((await api.capabilities()).features.sensitive_documents !== true) return;
      const kinds = (await api.documentTypes(token, { all: true })).items;
      expect(kinds.find((k) => k.key === 'passport')?.sensitive_default).toBe(true);
      expect(kinds.find((k) => k.key === 'bank_statement')?.sensitive_default).toBe(true);
      expect(kinds.find((k) => k.key === 'utility_bill')?.sensitive_default).toBe(false);
      const TAG = 'sensitive-contract';
      const passport = await api.createDocument(token, {
        title: 'Contract sensitive passport',
        type_key: 'passport',
        tags: [TAG],
      });
      expect(passport).toMatchObject({ sensitive: null, sensitive_effective: true });
      let policy = await api.createDocument(token, {
        title: 'Contract sensitive bill',
        type_key: 'utility_bill',
        sensitive: true,
        tags: [TAG],
      });
      expect(policy).toMatchObject({ sensitive: true, sensitive_effective: true });
      // What an older client sends: the card, without the field.
      policy = await api.updateDocument(
        token,
        policy.id,
        { title: 'Contract sensitive bill, paid' },
        policy.etag,
      );
      expect(policy).toMatchObject({ sensitive: true, sensitive_effective: true });
      policy = await api.updateDocument(token, policy.id, { sensitive: null }, policy.etag);
      expect(policy).toMatchObject({ sensitive: null, sensitive_effective: false });
      const titles = async (sensitive: string) =>
        (await api.documents(token, { sort: 'title', tag: TAG, sensitive })).items.map(
          (d) => d.title,
        );
      expect(await titles('yes')).toEqual(['Contract sensitive passport']);
      expect(await titles('no')).toEqual(['Contract sensitive bill, paid']);
      expect(await titles('yes,no')).toHaveLength(2);
    },
  },
  {
    name: 'Health’s kinds, listed and filed; a yearly review on, once, and off (0.9.0, H3)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.health_kinds).toBe(true);
      const kinds = (await api.documentTypes(token)).items;
      const of = (key: string) => kinds.find((t) => t.key === key);
      for (const key of [
        'insurance_card',
        'lab_result',
        'vaccination_record',
        'advance_directive',
      ]) {
        expect(of(key), key).toMatchObject({
          category: 'medical',
          default_visibility: 'adults',
          sensitive_default: true,
          builtin: true,
        });
      }
      // A vaccination record reminds from its next dose, which is never required.
      expect(of('vaccination_record')?.remind_from).toBe('next_dose_due');
      expect(of('vaccination_record')?.fields.find((f) => f.key === 'next_dose_due')).toMatchObject(
        { kind: 'date', required: false },
      );
      const me = await api.me(token);
      const make = (title: string, type_key: string) =>
        api.createDocument(token, {
          title,
          type_key,
          owner_member_id: me.member_id,
          visibility: 'adults',
        });
      const directive = await make('Contract living will', 'advance_directive');
      const lab = await make('Contract bloods', 'lab_result');
      expect(directive.sensitive_effective).toBe(true);
      const on = await api.createReminder(token, {
        document_id: directive.id,
        fire_at: '2031-03-10',
        review: true,
      });
      expect(on).toMatchObject({
        kind: 'manual',
        recurrence: 'annual',
        review: true,
        note: 'Yearly review',
        fire_at: '2031-03-10',
      });
      // On again: the one there is.
      const again = await api.createReminder(token, {
        document_id: directive.id,
        fire_at: '2031-04-01',
        review: true,
      });
      expect(again.id).toBe(on.id);
      // Not on a lab result.
      const refused = await refusal(
        api.createReminder(token, { document_id: lab.id, fire_at: '2031-03-10', review: true }),
      );
      expect(refused.status).toBe(422);
      expect(refused.detail).toBe('review');
      // One document's reminders.
      const mine = (await api.reminders(token, 'all', directive.id)).items;
      expect(mine.map((r) => r.id)).toEqual([on.id]);
      expect((await api.reminders(token, 'all', lab.id)).items).toEqual([]);
      // Off.
      await api.deleteReminder(token, on.id);
      expect((await api.reminders(token, 'all', directive.id)).items).toEqual([]);
      await api.deleteDocument(token, directive.id);
      await api.deleteDocument(token, lab.id);
    },
  },
  {
    name: 'Emergency information: written to the version read, who sees it chosen, a clinician’s link made, listed and taken back (0.9.0, H4)',
    run: async (api, ctx) => {
      const { access_token: token, member_id: me } = await signIn(api, ctx);
      expect((await api.capabilities()).features.emergency_info).toBe(true);
      const empty = await api.emergencyOf(token, me);
      expect(empty).toMatchObject({ version: 0, can_edit: true, can_choose: true });
      expect(empty.audience).toBe('adults');
      const first = await api.saveEmergency(
        token,
        me,
        {
          blood_type: 'A+',
          allergies: [{ id: 'a1', name: 'Contract allergy' }],
          emergency_contacts: [{ id: 'p1', name: 'Contract contact', phone: '+44 7700 900000' }],
        },
        0,
      );
      expect(first.version).toBe(1);
      expect(first.fields.allergies).toEqual([{ id: 'a1', name: 'Contract allergy' }]);
      // Made from a version moved on: refused.
      const stale = await refusal(api.saveEmergency(token, me, { notes: 'late' }, 0));
      expect([stale.status, stale.code]).toEqual([409, 'conflict']);
      // Who sees it: the person's to choose.
      const narrowed = await api.setEmergencyAudience(token, me, { audience: 'owners_and_self' });
      expect(narrowed.audience).toBe('owners_and_self');
      expect(narrowed.version).toBe(2);
      // A link: the parts ticked, for hours.
      const made = await api.makeEmergencyLink(token, me, {
        fields: ['blood_type', 'allergies'],
        with_pin: true,
        recipient_label: 'Contract clinic',
      });
      expect(made.pin).toMatch(/^\d{4}$/);
      expect(made.share.document_id).toBeNull();
      const hours = (Date.parse(made.share.expires_at) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(3.5);
      expect(hours).toBeLessThanOrEqual(4.01);
      const tooLong = await refusal(
        api.makeEmergencyLink(token, me, { fields: ['allergies'], expires_in_hours: 25 }),
      );
      expect(tooLong.status).toBe(422);
      const listed = (await api.emergencyLinks(token, me)).items;
      const link = listed.find((l) => l.id === made.share.id);
      expect(link).toMatchObject({
        emergency_fields: ['blood_type', 'allergies'],
        openings: [],
        recipient_label: 'Contract clinic',
        state: 'active',
      });
      await api.revokeEmergencyLink(token, me, made.share.id);
      const after = (await api.emergencyLinks(token, me)).items.find((l) => l.id === made.share.id);
      expect(after?.state).toBe('revoked');
      const again = await refusal(api.revokeEmergencyLink(token, me, made.share.id));
      expect(again.status).toBe(404);
    },
  },
  {
    name: 'several documents as one ZIP: what the caller may download, a note as Markdown, an index; a collection too; nothing to give refused (0.9.0, DL)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.zip_download).toBe(true);
      const me = await api.me(token);
      const plain = {
        type_key: 'utility_bill',
        owner_member_id: me.member_id,
        visibility: 'household' as const,
        sensitive: false,
      };
      const bill = await api.createDocument(token, { ...plain, title: 'Contract zip bill' });
      const form = multipartBody([
        { name: 'file', filename: 'bill.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      await api.upload(
        token,
        bill.id,
        { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
        ZIP_KEY,
      );
      const note = await api.createDocument(token, {
        type_key: 'note',
        title: 'Contract zip note',
        owner_member_id: me.member_id,
        visibility: 'household',
        notes: 'Ring Ann first',
      });
      const paper = await api.createDocument(token, { ...plain, title: 'Contract zip paper' });

      const res = await api.downloadZip(token, { document_ids: [bill.id, note.id, paper.id] });
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toMatch(
        /^attachment; filename\*=UTF-8''.+\.zip$/,
      );
      expect(zipEntryNames(new Uint8Array(await res.arrayBuffer())).sort()).toEqual([
        'Contract zip bill.pdf',
        'Contract zip note.md',
        'index.csv',
        'index.html',
      ]);
      // Nothing with a file, and nothing there at all.
      const none = await refusal(api.downloadZip(token, { document_ids: [paper.id] }));
      expect([none.status, none.code]).toEqual([422, 'nothing_to_zip']);
      const missing = await refusal(api.downloadZip(token, { document_ids: [NEVER_USED] }));
      expect(missing.status).toBe(404);

      const collection = await api.createCollection(token, {
        name: 'Contract zip',
        audience: 'everyone',
      });
      await api.addToCollection(token, collection.id, [bill.id, note.id]);
      const all = await api.downloadCollectionZip(token, collection.id);
      expect(zipEntryNames(new Uint8Array(await all.arrayBuffer())).sort()).toEqual([
        'Contract zip bill.pdf',
        'Contract zip note.md',
        'index.csv',
        'index.html',
      ]);
      const elsewhere = await refusal(api.downloadCollectionZip(token, NEVER_USED));
      expect(elsewhere.status).toBe(404);
      // By a ticket, as a browser saves it: asked first, then the ZIP once.
      const refusedTicket = await refusal(
        api.downloadZipTicket(token, { document_ids: [paper.id] }),
      );
      expect([refusedTicket.status, refusedTicket.code]).toEqual([422, 'nothing_to_zip']);
      const ticket = await api.collectionZipTicket(token, collection.id);
      expect(ticket.url).toMatch(/^\/api\/v1\/downloads\/.+/);
      const byTicket = await api.http.raw(ticket.url);
      expect(byTicket.headers.get('content-type')).toBe('application/zip');
      expect(zipEntryNames(new Uint8Array(await byTicket.arrayBuffer())).sort()).toEqual([
        'Contract zip bill.pdf',
        'Contract zip note.md',
        'index.csv',
        'index.html',
      ]);
      const twice = await refusal(api.http.raw(ticket.url));
      expect([twice.status, twice.code]).toEqual([404, 'download_ticket_gone']);
    },
  },
  {
    name: 'a link and a request changed by whoever made them, and a request shown again (0.9.0, LK)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.link_changes).toBe(true);
      const me = await api.me(token);
      const doc = await api.createDocument(token, {
        type_key: 'utility_bill',
        owner_member_id: me.member_id,
        visibility: 'household',
        sensitive: false,
        title: 'Contract changed link',
      });
      const form = multipartBody([
        { name: 'file', filename: 'lease.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      await api.upload(
        token,
        doc.id,
        { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
        LK_KEY,
      );
      const made = await api.share(token, doc.id, {
        with_pin: true,
        recipient_label: 'Contract agent',
      });
      expect(made.share).toMatchObject({ changeable: true, version: 1 });
      const end = new Date(Date.now() + 2 * 864e5).toISOString();
      const changed = await api.changeShare(
        token,
        made.share.id,
        { expires_at: end, recipient_label: 'Contract new agent', secret: 'pin' },
        made.share.version,
      );
      expect([...changed.changed].sort()).toEqual(['expires_at', 'recipient_label', 'secret']);
      expect(changed.pin).toMatch(/^\d{4}$/);
      expect(changed.share).toMatchObject({
        recipient_label: 'Contract new agent',
        expires_at: end,
        version: 2,
      });
      // Shown again, it is the new PIN.
      expect(await api.revealShare(token, made.share.id)).toMatchObject({
        link_token: made.link_token,
        pin: changed.pin,
      });
      const stale = await refusal(
        api.changeShare(token, made.share.id, { recipient_label: 'Late' }, 1),
      );
      expect([stale.status, stale.code]).toEqual([409, 'conflict']);
      const tooLong = await refusal(
        api.changeShare(token, made.share.id, {
          expires_at: new Date(Date.parse(made.share.created_at) + 91 * 864e5).toISOString(),
        }),
      );
      expect([tooLong.status, tooLong.code]).toEqual([422, 'expiry_out_of_range']);
      await api.revokeShare(token, made.share.id);
      const ended = await refusal(
        api.changeShare(token, made.share.id, { recipient_label: 'Back again' }),
      );
      expect([ended.status, ended.code]).toEqual([410, 'share_ended']);

      // A request to send documents: shown again, and changed.
      const ask = await api.createUploadRequest(token, {
        title: 'Contract changed request',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        with_password: true,
      });
      expect(ask.request).toMatchObject({ revealable: true, changeable: true, version: 1 });
      expect(await api.revealUploadRequest(token, ask.request.id)).toEqual({
        link_token: ask.link_token,
        link_url: ask.link_url,
        password: ask.password,
      });
      const asked = await api.changeUploadRequest(
        token,
        ask.request.id,
        { max_visits: 2, secret: 'password' },
        1,
      );
      expect([...asked.changed].sort()).toEqual(['max_visits', 'secret']);
      expect(asked.request).toMatchObject({ max_visits: 2, version: 2 });
      expect(asked.password).toBeTruthy();
      expect((await api.revealUploadRequest(token, ask.request.id)).password).toBe(asked.password);
      // What it asks for, in words, changes (16 Nov 2026); who looks at what
      // comes in does not.
      const retitled = await api.changeUploadRequest(token, ask.request.id, {
        title: 'Contract renamed request',
        message: 'The usual papers, please.',
      });
      expect([...retitled.changed].sort()).toEqual(['message', 'title']);
      expect(retitled.request).toMatchObject({
        title: 'Contract renamed request',
        message: 'The usual papers, please.',
      });
      const reviewer = await refusal(
        api.changeUploadRequest(token, ask.request.id, { review_by: 'adults' } as never),
      );
      expect(reviewer.status).toBe(422);
      // Emailed by the vault, where it can send mail.
      if ((await api.capabilities()).features.upload_request_email === true) {
        const sent = await api.emailUploadRequest(token, ask.request.id, {
          to: 'contract.recipient@example.test',
        });
        expect(sent.sent_to).toContain('•');
        // Listed with where it went and who sent it (16 Nov 2026).
        const listed = (await api.uploadRequests(token)).items.find((r) => r.id === ask.request.id);
        expect(listed?.emailed_to).toBe(sent.sent_to);
        expect(typeof listed?.emailed_by_name).toBe('string');
      } else {
        const none = await refusal(
          api.emailUploadRequest(token, ask.request.id, { to: 'contract.recipient@example.test' }),
        );
        expect([none.status, none.code]).toEqual([503, 'email_link_unavailable']);
      }
      await api.revokeUploadRequest(token, ask.request.id);
      const gone = await refusal(api.revealUploadRequest(token, ask.request.id));
      expect([gone.status, gone.code]).toEqual([410, 'request_ended']);
    },
  },
  {
    name: 'a request asks for a PIN, shown again and made new; and texted where the household can (0.9.0-dev.69)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      const caps = await api.capabilities();
      expect(caps.features.upload_request_pin).toBe(true);
      expect(caps.features.link_texts).toBe(true);
      const expires_at = new Date(Date.now() + 7 * 864e5).toISOString();
      const ask = await api.createUploadRequest(token, {
        title: 'Contract PIN request',
        expires_at,
        with_pin: true,
      });
      // Four digits, shown as it is made, and again; never with a password.
      expect(ask.pin).toMatch(/^\d{4}$/);
      expect(ask).not.toHaveProperty('password');
      expect(ask.request.protection).toEqual(['pin']);
      expect((await api.revealUploadRequest(token, ask.request.id)).pin).toBe(ask.pin);
      const both = await refusal(
        api.createUploadRequest(token, {
          title: 'Contract both secrets',
          expires_at,
          with_pin: true,
          with_password: true,
        }),
      );
      expect([both.status, both.code]).toEqual([422, 'validation_failed']);
      // A new PIN replaces the old one, and is what Show the link shows.
      const renewed = await api.changeUploadRequest(token, ask.request.id, { secret: 'pin' });
      expect(renewed.changed).toEqual(['secret']);
      expect(renewed.pin).toMatch(/^\d{4}$/);
      expect(renewed.request.protection).toContain('pin');
      expect((await api.revealUploadRequest(token, ask.request.id)).pin).toBe(renewed.pin);
      // Texted by the vault while the household's texts are set up; said so otherwise.
      const listed = (await api.uploadRequests(token)).items.find((r) => r.id === ask.request.id);
      if (listed?.textable === true) {
        const sent = await api.textUploadRequest(token, ask.request.id, { to: '07700 900123' });
        expect(sent.sent_to).toMatch(/•.*123$/);
        const after = (await api.uploadRequests(token)).items.find((r) => r.id === ask.request.id);
        expect(after?.texted_to).toBe(sent.sent_to);
      } else {
        const none = await refusal(
          api.textUploadRequest(token, ask.request.id, { to: '07700 900123' }),
        );
        expect([none.status, none.code]).toEqual([409, 'sms_not_set_up']);
      }
      await api.revokeUploadRequest(token, ask.request.id);
      const gone = await refusal(
        api.textUploadRequest(token, ask.request.id, { to: '07700 900123' }),
      );
      expect([404, 409, 410]).toContain(gone.status);
    },
  },
  {
    name: 'where the original is, as a folder of my cabinet: set, followed, found and cleared (0.9.0, C3)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.original_place).toBe(true);
      const me = await api.me(token);
      const doc = await api.createDocument(token, {
        type_key: 'utility_bill',
        owner_member_id: me.member_id,
        visibility: 'household',
        sensitive: false,
        title: 'Contract filed bill',
      });
      const other = await api.createDocument(token, {
        type_key: 'utility_bill',
        owner_member_id: me.member_id,
        visibility: 'household',
        sensitive: false,
        title: 'Contract other bill',
      });
      const folder = (id: string, name: string) => ({
        id,
        name,
        hidden: false,
        filter: { category: 'bills' },
      });
      const layout = (name: string, folders = [folder('ctr-bills', name)]) => ({
        levels: ['topic', 'year', 'person'] as CabinetLevel[],
        cabinets: [
          {
            id: 'ctr-cab',
            name: 'Contract cabinet',
            hidden: false,
            drawn: { value: 'bills' },
            drawers: [{ id: 'ctr-drawer', name: 'Top drawer', hidden: false, folders }],
          },
        ],
      });
      const at = await api.cabinet(token);
      const saved = await api.saveCabinet(token, {
        layout: layout('Bills 2026'),
        version: at.version,
      });
      // A folder that is not one of mine is refused, nothing set.
      const stranger = await refusal(api.setOriginalPlace(token, doc.id, 'not-mine'));
      expect([stranger.status, stranger.code]).toEqual([422, 'validation_failed']);
      const set = await api.setOriginalPlace(token, doc.id, 'ctr-bills', doc.etag);
      expect(set.original_place).toEqual({
        path: ['Contract cabinet', 'Top drawer', 'Bills 2026'],
        folder_id: 'ctr-bills',
      });
      // The free text stays its own.
      expect(set.physical_location).toBeNull();
      // Filtered and sorted by it, as the table does: the whole path, or its cabinet.
      for (const asked of ['Contract cabinet › Top drawer › Bills 2026', 'contract cabinet']) {
        const page = await api.documents(token, {
          sort: 'original_place',
          original_place: asked,
          limit: 200,
        });
        expect(page.items.map((d) => d.id)).toContain(doc.id);
        expect(page.items.map((d) => d.id)).not.toContain(other.id);
      }
      // Renamed in my cabinet: the place follows.
      const renamed = await api.saveCabinet(token, {
        layout: layout('Bills, 2026'),
        version: saved.version,
      });
      expect((await api.document(token, doc.id)).original_place?.path).toEqual([
        'Contract cabinet',
        'Top drawer',
        'Bills, 2026',
      ]);
      // Many at once: the same place for both, then none.
      const both = await api.setOriginalPlaces(token, {
        document_ids: [doc.id, other.id],
        folder_id: 'ctr-bills',
      });
      expect(both).toEqual({ changed: [other.id], unchanged: [doc.id], not_yours: [] });
      // The folder taken out of my cabinet: the names stay, as words.
      await api.saveCabinet(token, {
        layout: layout('unused', [folder('ctr-other', 'Something else')]),
        version: renamed.version,
      });
      expect((await api.document(token, other.id)).original_place).toEqual({
        path: ['Contract cabinet', 'Top drawer', 'Bills, 2026'],
        folder_id: null,
      });
      const cleared = await api.setOriginalPlaces(token, {
        document_ids: [doc.id, other.id],
        folder_id: null,
      });
      expect([...cleared.changed].sort()).toEqual([doc.id, other.id].sort());
      expect((await api.document(token, doc.id)).original_place).toBeNull();
      const missing = await refusal(
        api.setOriginalPlaces(token, {
          document_ids: [doc.id, '00000000-0000-4000-8000-000000000000'],
          folder_id: null,
        }),
      );
      expect(missing.status).toBe(404);
    },
  },
  {
    name: 'the folder a paper came from: kept as it is filed, found, drawn into my cabinet beside what is there, and forgotten (0.9.0, C4)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.source_folders).toBe(true);
      const me = await api.me(token);
      const b = await api.createBatch(token, { name: 'Contract tree' });
      const file = (n: string) => ({
        kind: 'bytes' as const,
        filename: `${n}.pdf`,
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode(`%PDF-1.4\n% the contract tree ${n}\n%%EOF\n`),
      });
      const top = await api.addBatchItem(token, b.id, file('top'), undefined, {
        relativePath: 'Contract tree/top.pdf',
      });
      const deep = await api.addBatchItem(token, b.id, file('deep'), undefined, {
        relativePath: 'Contract tree/Bills 2026/deep.pdf',
      });
      const details = (title: string) => ({
        type_key: 'utility_bill',
        owner_member_id: me.member_id,
        visibility: 'household' as const,
        sensitive: false,
        title,
      });
      const a = await api.acceptBatchItem(token, b.id, top.id, details('Contract tree top'));
      const c = await api.acceptBatchItem(token, b.id, deep.id, details('Contract tree deep'));
      // Kept on the document as it is filed, without the file's own name.
      expect((await api.document(token, a.document_id)).source_folder).toBe('Contract tree');
      expect((await api.document(token, c.document_id)).source_folder).toBe(
        'Contract tree/Bills 2026',
      );
      // Found by it in the table, exactly, whatever the case: not the folders inside.
      const page = await api.documents(token, {
        sort: 'title',
        source_folder: 'contract TREE',
        limit: 200,
      });
      expect(page.items.map((d) => d.id)).toContain(a.document_id);
      expect(page.items.map((d) => d.id)).not.toContain(c.document_id);
      // As the table's other additions, only with a column sort.
      const older = await refusal(api.documents(token, { source_folder: 'Contract tree' }));
      expect([older.status, older.code]).toEqual([422, 'validation_failed']);

      // Drawn into my cabinet, beside what is there: shown, not saved.
      const before = await api.cabinet(token);
      const drawn = await api.cabinetFromFolders(token);
      expect(drawn.version).toBe(before.version);
      expect(await api.cabinet(token)).toEqual(before);
      expect(drawn.folders).toEqual(
        expect.arrayContaining([
          { path: 'Contract tree', documents: 1 },
          { path: 'Contract tree/Bills 2026', documents: 1 },
        ]),
      );
      const tree = drawn.layout.cabinets.find((x) => x.name === FOLDERS_CABINET && !x.hidden);
      const drawer = tree?.drawers.find((d) => d.name === 'Contract tree');
      expect(drawer?.folders.map((f) => [f.name, f.filter])).toEqual([
        ['Contract tree', { source_folder: 'Contract tree', notes: 'exclude' }],
        ['Bills 2026', { source_folder: 'Contract tree/Bills 2026', notes: 'exclude' }],
      ]);
      for (const f of drawer?.folders ?? []) expect(drawn.counts[f.id]).toBe(1);
      // Nothing there before is changed.
      for (const was of before.layout?.cabinets ?? []) {
        expect(drawn.layout.cabinets).toContainEqual(was);
      }
      // Not kept (0.9.0-dev.94): every cabinet is drawn by the arrangement's
      // levels, and "My folders" is not, so the layout is refused, nothing saved.
      const loose = await refusal(
        api.saveCabinet(token, { layout: drawn.layout, version: drawn.version }),
      );
      expect([loose.status, loose.code]).toEqual([422, 'cabinet_levels']);
      expect(await api.cabinet(token)).toEqual(before);

      // Forgotten, never written.
      const written = await refusal(
        api.updateDocument(token, c.document_id, { source_folder: 'Elsewhere' } as never),
      );
      expect([written.status, written.code]).toEqual([422, 'validation_failed']);
      const forgotten = await api.forgetSourceFolder(token, a.document_id);
      expect(forgotten.source_folder).toBeNull();
      expect((await api.document(token, c.document_id)).source_folder).toBe(
        'Contract tree/Bills 2026',
      );

      // The papers in the Trash.
      await api.removeBatch(token, b.id);
      await api.deleteDocument(token, a.document_id);
      await api.deleteDocument(token, c.document_id);
    },
  },
  {
    name: 'my cabinet arranged by levels I choose, a cabinet its own, and a folder divided by kind then year as one flat list (0.9.0-dev.90)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.cabinet_levels).toBe(true);
      const me = await api.me(token);
      const paper = (type_key: string, day: string, title: string) =>
        api.createDocument(token, {
          type_key,
          owner_member_id: me.member_id,
          visibility: 'household',
          sensitive: false,
          title,
          issued: { date: day, precision: 'day' },
        });
      const bank14 = await paper('bank_statement', '2014-03-01', 'Contract levels bank 2014');
      const bank15 = await paper('bank_statement', '2015-03-01', 'Contract levels bank 2015');
      const card15 = await paper('credit_card_statement', '2015-04-01', 'Contract levels card');
      const before = await api.cabinet(token);

      // Two to five levels, each once: anything else is refused, nothing drawn.
      for (const levels of [
        ['year'],
        ['year', 'year'],
        ['person', 'kind', 'year', 'topic', 'person'],
      ]) {
        const wrong = await refusal(api.previewCabinet(token, { levels: levels as never }));
        expect([wrong.status, wrong.code]).toEqual([422, 'cabinet_levels']);
      }
      // Two levels: one cabinet, drawers by person and folders by kind, divided by year.
      const two = await api.previewCabinet(token, {
        levels: ['person', 'kind'],
        layout: { levels: null, cabinets: [] },
      });
      expect(two.layout.levels).toEqual(['person', 'kind']);
      expect(two.layout.cabinets.map((c) => [c.name, c.drawn])).toEqual([
        ['My cabinet', { value: null }],
      ]);
      const folders = two.layout.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders));
      for (const f of folders) expect(f.dividers).toEqual({ levels: ['year'], ranges: [] });
      expect(two.size).toMatchObject({ cabinets: 1, folders: folders.length, over: null });

      // Four: a cabinet for each person, then topic, then year; kind divides each folder.
      const four = await api.previewCabinet(token, {
        levels: ['person', 'topic', 'year', 'kind'],
        layout: { levels: null, cabinets: [] },
      });
      const mine = four.layout.cabinets.find((c) => c.drawn?.value === me.member_id);
      expect(mine).toBeDefined();
      for (const f of mine?.drawers.flatMap((d) => d.folders) ?? []) {
        expect(f.filter.member_id).toBe(me.member_id);
        expect(f.dividers).toEqual({ levels: ['kind'], ranges: [] });
      }
      // Kept, then that cabinet given its own order below it: by year, then kind.
      const kept = await api.saveCabinet(token, { layout: four.layout, version: before.version });
      expect(kept.layout?.levels).toEqual(['person', 'topic', 'year', 'kind']);
      const own = await api.previewCabinet(token, {
        levels: ['person', 'topic', 'year', 'kind'],
        cabinet: { id: mine?.id ?? '', levels: ['year', 'kind'] },
      });
      const itsOwn = own.layout.cabinets.find((c) => c.id === mine?.id);
      expect(itsOwn?.drawn).toEqual({ value: me.member_id, levels: ['year', 'kind'] });
      // The cabinet level itself is never one of its own.
      const below = await refusal(
        api.previewCabinet(token, {
          levels: ['person', 'topic', 'year', 'kind'],
          cabinet: { id: mine?.id ?? '', levels: ['person', 'kind'] },
        }),
      );
      expect([below.status, below.code]).toEqual([422, 'cabinet_levels']);
      const ownKept = await api.saveCabinet(token, { layout: own.layout, version: kept.version });

      // A folder of my own, divided by kind and then year: one flat list of
      // leaves, each named by its steps, an older app's list as it is.
      const layout = {
        levels: ['person', 'topic', 'year', 'kind'] as CabinetLevel[],
        cabinets: [
          {
            id: 'ctr-levels',
            name: 'Contract levels',
            hidden: false,
            drawn: { value: me.member_id },
            drawers: [
              {
                id: 'ctr-levels-d',
                name: 'Old years',
                hidden: false,
                folders: [
                  {
                    id: 'ctr-levels-f',
                    name: '2014 and 2015',
                    hidden: false,
                    filter: {
                      member_id: me.member_id,
                      dated_from: '2014-01-01',
                      dated_to: '2015-12-31',
                      notes: 'exclude',
                    },
                    dividers: { levels: ['kind' as const, 'year' as const], ranges: [] },
                  },
                ],
              },
            ],
          },
        ],
      };
      await api.saveCabinet(token, { layout, version: ownKept.version });
      const opened = await api.cabinetFolder(token, 'ctr-levels-f');
      const leaf = opened.dividers.find((d) => d.key === 'kind:bank_statement/year:2015');
      expect(leaf).toMatchObject({ kind: 'group', from: '2015-01-01', to: '2015-12-31' });
      expect(leaf?.path?.map((s) => [s.level, s.key])).toEqual([
        ['kind', 'kind:bank_statement'],
        ['year', 'year:2015'],
      ]);
      expect(leaf?.name).toBe(`${leaf?.path?.[0]?.name ?? ''} · 2015`);
      const behind = await api.cabinetFolderDocuments(token, 'ctr-levels-f', {
        divider: 'kind:bank_statement/year:2015',
      });
      expect(behind.items.map((d) => d.id)).toContain(bank15.id);
      expect(behind.items.map((d) => d.id)).not.toContain(bank14.id);
      expect(behind.items.map((d) => d.id)).not.toContain(card15.id);
      // A kind whose papers here are all of one year: that year passed over.
      const card = opened.dividers.find((d) => d.path?.[0]?.key === 'kind:credit_card_statement');
      expect(card).toBeDefined();
      const cards = await api.cabinetFolderDocuments(token, 'ctr-levels-f', {
        divider: card?.key ?? '',
      });
      expect(cards.items.map((d) => d.id)).toContain(card15.id);
      // A step the folder is not divided by is no divider of it.
      const stranger = await refusal(
        api.cabinetFolderDocuments(token, 'ctr-levels-f', { divider: 'topic:financial' }),
      );
      expect(stranger.status).toBe(404);

      // The cabinet as it was, where there was one, and the papers in the Trash.
      const now = await api.cabinet(token);
      if (before.layout) {
        await api.saveCabinet(token, { layout: before.layout, version: now.version });
      }
      for (const d of [bank14, bank15, card15]) await api.deleteDocument(token, d.id);
    },
  },
  {
    name: 'who issued it as a level: one key whatever the spelling, the household’s Same as list suggested, joined and separated, and No issuer given (0.9.0-dev.91)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      expect((await api.capabilities()).features.cabinet_issuer).toBe(true);
      const me = await api.me(token);
      const paper = (title: string, issued_by: string | null) =>
        api.createDocument(token, {
          type_key: 'bank_statement',
          owner_member_id: me.member_id,
          visibility: 'household',
          sensitive: false,
          title,
          issued: { date: '2016-03-01', precision: 'day' },
          ...(issued_by ? { issued_by } : {}),
        });
      const a = await paper('Contract issuer A', 'Wrenfold Bank');
      const b = await paper('Contract issuer B', 'WRENFOLD BANK PLC');
      const c = await paper('Contract issuer C', 'Wrenfold Bank Savings');
      const none = await paper('Contract issuer none', null);

      // One key whatever the spelling; the longer one only suggested.
      const groups = await api.issuerGroups(token);
      expect(groups.may_change).toBe(true);
      expect(groups.items.find((g) => g.key === 'wrenfold bank')?.count).toBe(2);
      expect(groups.same_as).toContainEqual({
        from: { key: 'wrenfold bank savings', name: 'Wrenfold Bank Savings', count: 1 },
        to: { key: 'wrenfold bank', name: expect.any(String) as string, count: 2 },
      });
      const ids = async (params: Record<string, string>) =>
        (await api.documents(token, { sort: 'title', limit: 200, ...params })).items.map(
          (d) => d.id,
        );
      expect(await ids({ issuer: 'wrenfold bank' })).toEqual([a.id, b.id]);
      expect(await ids({ issuer: '_none' })).toContain(none.id);
      const wrong = await refusal(api.documents(token, { sort: 'title', issuer: 'Not A Key' }));
      expect([wrong.status, wrong.code]).toEqual([422, 'validation_failed']);

      // Said to be the same: the filter and the cabinet follow; no paper changes.
      const joined = await api.sameIssuer(token, {
        from: 'wrenfold bank savings',
        to: 'wrenfold bank',
      });
      expect(
        joined.items.find((g) => g.key === 'wrenfold bank')?.members.map((m) => m.key),
      ).toEqual(['wrenfold bank savings']);
      expect(await ids({ issued_by: 'Wrenfold Bank' })).toEqual([a.id, b.id, c.id]);
      expect((await api.document(token, c.id)).issued_by).toBe('Wrenfold Bank Savings');
      const drawn = await api.previewCabinet(token, {
        levels: ['issuer', 'kind'],
        layout: { levels: null, cabinets: [] },
      });
      const drawers = drawn.layout.cabinets[0]?.drawers ?? [];
      const wrenfold = drawers.find((d) =>
        d.folders.some((f) => f.filter.issuer === 'wrenfold bank'),
      );
      expect(wrenfold?.folders.map((f) => drawn.counts[f.id])).toEqual([3]);
      expect(drawers[drawers.length - 1]?.name).toBe('No issuer given');
      expect(Array.isArray(drawn.same_as)).toBe(true);

      // Separated again: never suggested as one again.
      const apart = await api.separateIssuer(token, {
        from: 'wrenfold bank savings',
        to: 'wrenfold bank',
      });
      expect(apart.items.find((g) => g.key === 'wrenfold bank')?.members).toEqual([]);
      expect(apart.same_as.some((s) => s.from.key === 'wrenfold bank savings')).toBe(false);
      for (const d of [a, b, c, none]) await api.deleteDocument(token, d.id);
    },
  },
  {
    name: 'a health record kept as it is, downloaded only; who opened a link, when (0.9.0, H5)',
    run: async (api, ctx) => {
      const { access_token: token } = await signIn(api, ctx);
      const caps = await api.capabilities();
      expect(caps.features.record_formats).toBe(true);
      expect(caps.features.share_opens).toBe(true);
      const me = await api.me(token);
      const doc = await api.createDocument(token, {
        type_key: 'utility_bill',
        owner_member_id: me.member_id,
        visibility: 'household',
        sensitive: false,
        title: 'Contract FHIR export',
      });
      const form = multipartBody([
        {
          name: 'file',
          filename: 'export.json',
          contentType: 'application/fhir+json',
          bytes: new TextEncoder().encode('{"resourceType":"Bundle","entry":[]}\n'),
        },
      ]);
      await api.upload(
        token,
        doc.id,
        { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
        H5_KEY,
      );
      const [version] = (await api.versions(token, doc.id)).items;
      expect(version).toMatchObject({
        mime: 'application/json',
        stored_as_is: true,
        preview_pages: 0,
      });
      // Never to view: there are no pages.
      const view = await refusal(api.share(token, doc.id, { permission: 'view' }));
      expect([view.status, view.code]).toEqual([422, 'view_not_possible']);
      const made = await api.share(token, doc.id, {
        permission: 'download',
        recipient_label: 'Contract clinic',
      });
      expect(await api.shareOpens(token, made.share.id)).toEqual({
        share_id: made.share.id,
        recipient_label: 'Contract clinic',
        open_count: 0,
        items: [],
      });
      const listed = (await api.documentLinkOpens(token, doc.id)).items;
      expect(listed).toEqual([
        expect.objectContaining({
          share_id: made.share.id,
          mine: true,
          permission: 'download',
          open_count: 0,
          opens: [],
        }),
      ]);
      const unknown = await refusal(api.shareOpens(token, '00000000-0000-4000-8000-000000000000'));
      expect([unknown.status, unknown.code]).toEqual([404, 'not_found']);
      await api.revokeShare(token, made.share.id);
    },
  },
  {
    name: 'a connected app: connected with a code, given an API key, it sends, is answered again, and withdraws (0.9.0, APP1)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      expect((await api.capabilities()).features.connected_apps).toBe(true);
      const owner = await signIn(api, ctx);
      await ctx.ownerTwoStep(owner.access_token);
      connectedAppOwner = owner;
      const token = owner.access_token;
      // Connected with no key; an owner generates one (APP6), shown once.
      const made = await api.connectedApps.create(token, {
        name: 'Contract app',
        member_id: owner.member_id,
        allowed_kinds: ['bank_statement'],
      });
      expect(made).toMatchObject({ name: 'Contract app', state: 'active', mine: true });
      expect(made.keys).toEqual([]);
      expect(made.connection_string).toBe('');
      const { app, clientId, secret } = await keyedApp(api, token, made, ctx.fetch);
      const listed = (await api.connectedApps.list(token)).items.find((a) => a.id === made.id);
      expect(parseConnectionString(listed?.connection_string as string)).toMatchObject({
        client_id: clientId,
      });
      // The connection test.
      expect(await app.me()).toMatchObject({
        app: { id: made.id, name: 'Contract app' },
        state: 'active',
        scopes: ['documents.send'],
      });
      // Sent; sent again with the same bytes, answered so; with others, refused.
      const pdf = { bytes: PDF, filename: 'statement.pdf', contentType: 'application/pdf' };
      const sent = await app.send({
        externalId: 'contract-1',
        hints: { kind: 'bank_statement' },
        file: pdf,
      });
      expect(sent).toMatchObject({ status: 201, replayed: false, state: { state: 'waiting' } });
      expect(sent.state.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sent.state.byte_size).toBe(PDF.length);
      const again = await app.send({ externalId: 'contract-1', file: pdf });
      expect(again).toMatchObject({ status: 200, replayed: true, state: sent.state });
      const other = await refusal(
        app.send({
          externalId: 'contract-1',
          file: { ...pdf, bytes: new TextEncoder().encode('%PDF-1.4\n% other\n%%EOF\n') },
        }),
      );
      expect([other.status, other.code]).toEqual([409, 'external_id_conflict']);
      // A kind it may not send: refused, and kept as refused.
      const receipt = await refusal(
        app.send({ externalId: 'contract-2', hints: { kind: 'warranty' }, file: pdf }),
      );
      expect([receipt.status, receipt.code]).toEqual([422, 'kind_not_allowed']);
      expect(await app.status('contract-2')).toMatchObject({
        state: 'refused',
        refusal: 'kind_not_allowed',
      });
      expect(await app.statuses(['contract-1', 'contract-9'])).toEqual({
        items: [sent.state],
        unknown: ['contract-9'],
      });
      // Withdrawn while it waits.
      expect(await app.withdraw('contract-1')).toMatchObject({
        state: 'removed',
        removed_reason: 'withdrawn',
      });
      // The secret is never shown again: not in the list, not in the view.
      expect(JSON.stringify(await api.connectedApps.list(token))).not.toContain(secret);
      // A sign-in is no app, and an app's key is no sign-in.
      const bearer = await refusal(api.http.request('/api/v1/apps/me', { token }));
      expect([bearer.status, bearer.code]).toEqual([401, 'app_key_required']);
      const crossed = await refusal(app.request('GET', '/api/v1/documents'));
      expect([crossed.status, crossed.code]).toEqual([401, 'app_key_not_accepted']);
      // Listed for its owner; removed, and told so.
      expect((await api.connectedApps.list(token)).items.some((a) => a.id === made.id)).toBe(true);
      await api.connectedApps.remove(token, made.id);
      const gone = await refusal(app.me());
      expect([gone.status, gone.code]).toEqual([401, 'app_revoked']);
    },
  },
  {
    name: 'a connected app reads what its grants cover, follows the changes, and downloads (0.9.0, APP2)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      expect((await api.capabilities()).features.connected_app_reads).toBe(true);
      // The owner who connected the app before, with two-step sign-in on and a
      // code just given.
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      // An app of its own, and an API key for it (APP6).
      const made = await api.connectedApps.create(token, {
        name: 'Reader',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes: ['documents.send', 'documents.read', 'documents.download'],
      });
      expect(made.scopes).toEqual(['documents.send', 'documents.read', 'documents.download']);
      const { app } = await keyedApp(api, token, made, ctx.fetch);
      // Papers of the family's: a bill and a statement this year, a bill
      // three years old, and a passport.
      const day = (daysAgo: number) =>
        new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
      const file = async (key: string, type_key: string, title: string, issued: string) => {
        const form = multipartBody([
          {
            name: 'metadata',
            value: JSON.stringify({
              type_key,
              title,
              owner_member_id: owner.member_id,
              issued: { date: issued, precision: 'day' },
              visibility: 'household',
            }),
          },
          { name: 'file', filename: `${title}.pdf`, contentType: 'application/pdf', bytes: PDF },
        ]);
        const c = await api.capture(
          token,
          { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
          key,
        );
        return c.document_id;
      };
      const bill = await file(APP2_KEYS[0], 'utility_bill', 'Reader water bill', day(40));
      const statement = await file(APP2_KEYS[1], 'bank_statement', 'Reader statement', day(45));
      const oldBill = await file(APP2_KEYS[2], 'utility_bill', 'Reader old bill', day(3 * 365));
      const passport = await file(APP2_KEYS[3], 'passport', 'Reader passport', day(50));
      // Nothing yet: no grant, and nothing of its own.
      expect((await app.list()).items).toEqual([]);
      // These four are this scenario's; the vault holds other papers too.
      const ours = new Set([bill, statement, oldBill, passport]);
      const only = (ids: string[]) => ids.filter((id) => ours.has(id));
      const window = { from: day(46), to: day(39) };
      // Bills for a year: granted. A kind Sensitive by default asks first.
      const asked = await refusal(
        api.connectedApps.setGrants(token, made.id, {
          grants: [
            { category: 'bills', lookback_months: 12 },
            { kind: 'bank_statement', lookback_months: 12 },
          ],
        }),
      );
      expect([asked.status, asked.code]).toEqual([409, 'sensitive_confirm']);
      const never = await refusal(
        api.connectedApps.setGrants(token, made.id, {
          grants: [{ category: 'identity', lookback_months: 12 }],
        }),
      );
      expect([never.status, never.code]).toEqual([422, 'validation_failed']);
      const granted = await api.connectedApps.setGrants(token, made.id, {
        grants: [
          { category: 'bills', lookback_months: 12 },
          { kind: 'bank_statement', lookback_months: 12 },
        ],
        confirm_sensitive: true,
      });
      // (Bills are not sensitive by default, but a kind of the household's
      // own in that category may be: whether that grant was confirmed too is
      // the household's to say.)
      expect(granted.grants).toMatchObject([
        { kind: null, category: 'bills', lookback_months: 12 },
        { kind: 'bank_statement', category: null, lookback_months: 12, sensitive_confirmed: true },
      ]);
      expect((await app.me()).read?.grants).toEqual([
        { kind: 'bank_statement', lookback_months: 12 },
        { category: 'bills', lookback_months: 12 },
      ]);
      // Listed: the bill and the statement, newest paper first; never the
      // passport, nor the bill older than a year.
      const listed = await app.list(window);
      expect(listed.items.map((d) => d.id)).toEqual([bill, statement]);
      expect(listed.next).toBeNull();
      expect(only((await app.list()).items.map((d) => d.id))).toEqual([bill, statement]);
      expect(listed.items[0]).toMatchObject({
        kind: { key: 'utility_bill', category: 'bills' },
        title: 'Reader water bill',
        paper_date: day(40),
        issued: { date: day(40), precision: 'day' },
        own: false,
        external_id: null,
      });
      const keys = Object.keys(listed.items[0] as object);
      for (const never of ['owner_member_id', 'notes', 'tags', 'identifier', 'physical_location']) {
        expect(keys).not.toContain(never);
      }
      expect(
        (await app.list({ ...window, kind: ['bank_statement'] })).items.map((d) => d.id),
      ).toEqual([statement]);
      const paged = await app.list({ ...window, limit: 1 });
      expect(paged.items.map((d) => d.id)).toEqual([bill]);
      expect(
        (await app.list({ ...window, limit: 1, cursor: paged.next as string })).items.map(
          (d) => d.id,
        ),
      ).toEqual([statement]);
      // One document; one it may not read is the same 404 as one not there.
      expect(await app.document(bill)).toEqual(listed.items[0]);
      for (const id of [passport, oldBill, NEVER_USED]) {
        const no = await refusal(app.document(id));
        expect([no.status, no.code]).toEqual([404, 'not_found']);
      }
      // The feed: everything it may read, then what changed.
      const first = await app.changes();
      expect(
        only(
          first.changes.map((c) => (c.change === 'changed' ? c.document.id : c.document_id)),
        ).sort(),
      ).toEqual([bill, statement].sort());
      expect(first.changes.every((c) => c.change === 'changed')).toBe(true);
      expect(first.more).toBe(false);
      expect((await app.changes({ cursor: first.cursor })).changes).toEqual([]);
      await api.updateDocument(token, bill, { title: 'Reader water bill, paid' });
      await api.deleteDocument(token, statement);
      const next = await app.changes({ cursor: first.cursor });
      const byId = new Map(
        next.changes.map((c) => [c.change === 'changed' ? c.document.id : c.document_id, c]),
      );
      expect(byId.get(bill)).toMatchObject({
        change: 'changed',
        document: { title: 'Reader water bill, paid' },
      });
      // No longer readable, and never why.
      const gone = byId.get(statement);
      expect(gone && Object.keys(gone).sort()).toEqual(['at', 'change', 'document_id']);
      expect(gone).toMatchObject({ change: 'unavailable', document_id: statement });
      // Downloaded: an attachment; again by its version, 304; a range, 206.
      const got = await app.download(bill);
      expect(got.status).toBe(200);
      expect(Array.from(got.bytes)).toEqual(Array.from(PDF));
      expect(got.contentDisposition?.startsWith('attachment')).toBe(true);
      expect(got.etag).toMatch(/^"[^"]+"$/);
      expect((await app.download(bill, { ifNoneMatch: got.etag as string })).status).toBe(304);
      const part = await app.download(bill, { range: { start: 0, end: 3 } });
      expect([part.status, new TextDecoder().decode(part.bytes)]).toEqual([206, '%PDF']);
      const hidden = await refusal(app.download(passport));
      expect([hidden.status, hidden.code]).toEqual([404, 'not_found']);
      // Without its scope, refused.
      await api.connectedApps.update(token, made.id, { scopes: ['documents.send'] });
      const unread = await refusal(app.list());
      expect([unread.status, unread.code]).toEqual([403, 'scope_not_granted']);
      await api.connectedApps.remove(token, made.id);
    },
  },
  {
    name: 'a connected app’s link opens once for a session there, and its deletes keep to its own (0.9.0, APP3)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      const fetch = ctx.fetch;
      expect((await api.capabilities()).features.connected_app_links).toBe(true);
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const made = await api.connectedApps.create(token, {
        name: 'Linker',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes: ['documents.send', 'documents.read', 'documents.links', 'documents.delete'],
      });
      expect(made).toMatchObject({ delete_mode: 'unlink', links_per_hour: 60 });
      const { app } = await keyedApp(api, token, made, fetch);
      expect(await app.me()).toMatchObject({
        delete_mode: 'unlink',
        limits: { links_per_hour: 60 },
      });
      // A bill of the family's, granted.
      const issued = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const form = multipartBody([
        {
          name: 'metadata',
          value: JSON.stringify({
            type_key: 'utility_bill',
            title: 'Linked water bill',
            owner_member_id: owner.member_id,
            issued: { date: issued, precision: 'day' },
            visibility: 'household',
          }),
        },
        { name: 'file', filename: 'bill.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      const bill = (
        await api.capture(
          token,
          { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
          APP3_KEY,
        )
      ).document_id;
      const hidden = await refusal(app.link(bill, 'view'));
      expect([hidden.status, hidden.code]).toEqual([404, 'not_found']);
      // (A kind of the household's own in Bills may be Sensitive by default:
      // said yes to, as the reading scenario does.)
      await api.connectedApps.setGrants(token, made.id, {
        grants: [{ category: 'bills', lookback_months: 12 }],
        confirm_sensitive: true,
      });
      // A view link: within two minutes, for ten.
      const minted = await app.link(bill, 'view');
      expect(minted.mode).toBe('view');
      expect(minted.session_minutes).toBe(10);
      const left = Date.parse(minted.open_by) - Date.now();
      expect(left).toBeGreaterThan(60_000);
      expect(left).toBeLessThanOrEqual(121_000);
      const path = minted.url.replace(/^[a-z]+:\/\/[^/]+/i, '');
      expect(path).toMatch(/^\/api\/v1\/app-links\/[A-Za-z0-9_-]{43}$/);
      const get = (p: string, cookie?: string) =>
        fetch(`${api.http.baseUrl}${p}`, { method: 'GET', headers: cookie ? { cookie } : {} });
      // Its address is a page that opens nothing (0.9.0-dev.68): a link
      // preview's GETs leave it; the browser shows an Open button, and the
      // POST one click sends is the open.
      const open = (p: string, headers: Record<string, string> = {}) =>
        fetch(`${api.http.baseUrl}${p}`, { method: 'POST', headers });
      for (let i = 0; i < 2; i++) {
        const page = await get(path);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type') ?? '').toMatch(/^text\/html/);
        expect(page.headers.get('cache-control')).toBe('no-store');
        expect(page.headers.get('referrer-policy')).toBe('same-origin');
        expect(page.headers.get('set-cookie')).toBeNull();
        const words = await page.text();
        expect(words).not.toMatch(/<script/i);
        expect(words).toMatch(/<button type="submit">Open<\/button>/);
      }
      // From another site: refused, and the link is still there.
      const foreign = await open(path, { 'sec-fetch-site': 'cross-site' });
      expect(foreign.status).toBe(403);
      // Opened: a session's cookie for its path alone, and on to the page.
      const opened = await open(path, { 'sec-fetch-site': 'same-origin' });
      expect([opened.status, opened.headers.get('location')]).toEqual([303, '/a']);
      const set = opened.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/^__Secure-fdv_app_link=[A-Za-z0-9_-]{43};/);
      expect(set).toMatch(/Path=\/api\/v1\/app-links\/session/);
      expect(set).toMatch(/HttpOnly/);
      expect(set).toMatch(/Secure/);
      expect(set).toMatch(/SameSite=Lax/i);
      const cookie = set.split(';')[0] as string;
      // Once: opened again, the page says so.
      const again = await open(path);
      expect([again.status, again.headers.get('location')]).toEqual([303, '/a#used']);
      const session = await get('/api/v1/app-links/session', cookie);
      expect(session.status).toBe(200);
      const said = (await session.json()) as { opened_on?: unknown };
      expect(said).toMatchObject({ app: 'Linker', mode: 'view', title: 'Linked water bill' });
      // The day it was opened, for the page's watermark (0.9.0-dev.68).
      expect(String(said.opened_on)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Without its cookie, nothing.
      expect((await get('/api/v1/app-links/session')).status).toBe(410);
      // A download link needs documents.download too.
      const noDownload = await refusal(app.link(bill, 'download'));
      expect([noDownload.status, noDownload.code]).toEqual([403, 'scope_not_granted']);
      const bad = await refusal(
        app.request('POST', `/api/v1/apps/documents/${bill}/links`, {
          bytes: new TextEncoder().encode('{"mode":"print"}'),
          contentType: 'application/json',
        }),
      );
      expect([bad.status, bad.code]).toEqual([422, 'validation_failed']);
      // So many an hour, as the owner sets.
      await app.link(bill, 'view');
      await api.connectedApps.update(token, made.id, { links_per_hour: 2 });
      const full = await refusal(app.link(bill, 'view'));
      expect([full.status, full.code]).toEqual([429, 'app_links_full']);
      // Retriable, and when.
      expect(full.retriable).toBe(true);
      expect(full.retryAfterSeconds).toBeGreaterThan(0);
      // A delete: never one it reads by a grant.
      const notOwn = await refusal(app.delete(bill));
      expect([notOwn.status, notOwn.code]).toEqual([404, 'not_found']);
      await api.connectedApps.update(token, made.id, { delete_mode: 'trash' });
      expect((await app.me()).delete_mode).toBe('trash');
      // Its own, sent and filed by the family: moved to the Trash, and let go of.
      if (!ctx.fileAppSend)
        throw new Error('the contract needs its vault to file what an app sent');
      const ownBytes = new TextEncoder().encode('%PDF-1.4\n% the linker’s own\n%%EOF\n');
      const sent = await app.send({
        externalId: 'linker-own-1',
        hints: { kind: 'utility_bill' },
        file: { bytes: ownBytes, filename: 'own.pdf', contentType: 'application/pdf' },
      });
      expect(sent.status).toBe(201);
      const own = await ctx.fileAppSend(token, { id: made.id, name: made.name }, 'linker-own-1', {
        sha256: sent.state.sha256 as string,
        bytes: ownBytes,
      });
      expect(await app.status('linker-own-1')).toMatchObject({ state: 'filed', document_id: own });
      expect((await app.document(own)).own).toBe(true);
      expect(await app.delete(own)).toEqual({ document_id: own, result: 'trashed' });
      const trashed = await refusal(app.document(own));
      expect([trashed.status, trashed.code]).toEqual([404, 'not_found']);
      expect(await app.status('linker-own-1')).toMatchObject({
        state: 'unavailable',
        document_id: null,
      });
      const twice = await refusal(app.delete(own));
      expect([twice.status, twice.code]).toEqual([404, 'not_found']);
      // Unreadable now: the session ends, never why.
      await api.connectedApps.setGrants(token, made.id, { grants: [] });
      expect((await get('/api/v1/app-links/session', cookie)).status).toBe(410);
      await api.connectedApps.remove(token, made.id);
    },
  },
  {
    name: 'a connected app’s file is filed with nobody looking only when everything is sure and complete (0.9.0, APP4)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      if (!ctx.readAppSend)
        throw new Error('the contract needs its vault to read what an app sent');
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const made = await api.connectedApps.create(token, {
        name: 'Filer',
        member_id: owner.member_id,
        allowed_kinds: ['bank_statement'],
        scopes: ['documents.send', 'documents.read'],
        auto_file: true,
      });
      expect(made.auto_file).toBe(true);
      const { app } = await keyedApp(api, token, made, ctx.fetch);
      expect((await app.me()).send).toMatchObject({ auto_file: true });
      const pages: DetailProposal = {
        type_key: { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' },
        owner_member_id: { value: owner.member_id, confidence: 0.95, cue: 'name_on_page' },
      };
      const sendOne = async (externalId: string, hints: Record<string, unknown>) => {
        const sent = await app.send({
          externalId,
          hints,
          file: {
            bytes: new TextEncoder().encode(`%PDF-1.4
% ${externalId}
%%EOF
`),
            filename: `${externalId}.pdf`,
            contentType: 'application/pdf',
          },
        });
        expect(sent.status).toBe(201);
        return { sha256: sent.state.sha256 as string };
      };
      // Sure and complete: the pages read the kind and whose it is, and the app agrees.
      const sure = await sendOne('filer-1', { kind: 'bank_statement', title: 'Filer statement' });
      await ctx.readAppSend({ id: made.id }, 'filer-1', sure, pages);
      const filed = await app.status('filer-1');
      expect(filed.state).toBe('filed');
      expect((await app.document(filed.document_id as string)).own).toBe(true);
      // The app's word alone, the pages saying nothing: it waits for a look.
      const hinted = await sendOne('filer-2', { kind: 'bank_statement' });
      await ctx.readAppSend({ id: made.id }, 'filer-2', hinted, {});
      expect((await app.status('filer-2')).state).toBe('waiting');
      // Switched off: it waits too.
      await api.connectedApps.update(token, made.id, { auto_file: false });
      expect((await app.me()).send.auto_file).toBe(false);
      const off = await sendOne('filer-3', { kind: 'bank_statement' });
      await ctx.readAppSend({ id: made.id }, 'filer-3', off, pages);
      expect((await app.status('filer-3')).state).toBe('waiting');
      await api.connectedApps.remove(token, made.id);
    },
  },
  {
    name: 'a connected app downloads again the exact file it sent, while its document is in the vault (0.9.0, APP5)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      if (!ctx.fileAppSend)
        throw new Error('the contract needs its vault to file what an app sent');
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const made = await api.connectedApps.create(token, {
        name: 'Resender',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes: ['documents.send', 'documents.download'],
      });
      // Each paper to the person it is about, unless an owner says otherwise.
      expect(made.route_to_person).toBe(true);
      const { app } = await keyedApp(api, token, made, ctx.fetch);
      const bytes = new TextEncoder().encode('%PDF-1.4\n% the resender’s own\n%%EOF\n');
      const sent = await app.send({
        externalId: 'resend-1',
        hints: { kind: 'utility_bill' },
        file: { bytes, filename: 'resend.pdf', contentType: 'application/pdf' },
      });
      expect(sent.status).toBe(201);
      expect(sent.state.content_available).toBe(false);
      const waiting = await refusal(app.sentFile('resend-1'));
      expect([waiting.status, waiting.code]).toEqual([404, 'not_found']);
      const doc = await ctx.fileAppSend(token, { id: made.id, name: made.name }, 'resend-1', {
        sha256: sent.state.sha256 as string,
        bytes,
      });
      expect(await app.status('resend-1')).toMatchObject({
        state: 'filed',
        content_available: true,
      });
      const again = await app.sentFile('resend-1');
      expect(again.status).toBe(200);
      expect(again.bytes).toEqual(bytes);
      expect(again.etag).toMatch(/^"[^"]+"$/);
      expect(again.contentDisposition).toMatch(/^attachment/);
      // In the Trash: not any more, and its status says so.
      await api.deleteDocument(token, doc);
      const trashed = await refusal(app.sentFile('resend-1'));
      expect([trashed.status, trashed.code]).toEqual([404, 'not_found']);
      expect((await app.status('resend-1')).content_available).toBe(false);
      // Never one it did not send.
      const never = await refusal(app.sentFile('resend-never'));
      expect([never.status, never.code]).toEqual([404, 'not_found']);
      await api.connectedApps.remove(token, made.id);
    },
  },
  {
    name: 'a connected app’s API keys: generated by an owner, shown once, each with its own permissions and validity; expired, revoked and a third live key refused (0.9.0, APP6)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      const fetch = ctx.fetch;
      expect((await api.capabilities()).features.connected_app_keys).toBe(true);
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const made = await api.connectedApps.create(token, {
        name: 'Acme Money',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes: ['documents.send', 'documents.read'],
      });
      const client = (clientId: string, secret: string) =>
        createAppClient({ url: api.http.baseUrl, clientId, secret, fetch });

      // A key with every permission the app has, for 30 days: it works, and
      // `me()` describes it — the key making the call, and no other.
      const a = await keyedApp(api, token, made, fetch);
      const meA = await a.app.me();
      expect(meA.scopes).toEqual(['documents.send', 'documents.read']);
      expect(meA.key).toMatchObject({
        client_id: a.clientId,
        name: null,
        permissions: ['documents.send', 'documents.read'],
        last_used_at: expect.any(String) as string,
      });
      const left = Date.parse(meA.key.expires_at as string) - Date.now();
      expect(left).toBeGreaterThan(29.9 * 864e5);
      expect(left).toBeLessThanOrEqual(30 * 864e5 + 60_000);
      expect('keys' in meA).toBe(false);
      expect(JSON.stringify(meA)).not.toContain(a.secret);
      expect((await a.app.list()).items).toEqual(expect.any(Array));

      // Its permissions are some of the app's, at least one; it lasts 1 to
      // 3650 days, or never.
      for (const [why, body] of [
        ['a scope the app has not', { permissions: ['documents.delete'], expires_in_days: 30 }],
        ['no permission', { permissions: [], expires_in_days: 30 }],
        ['no days', { permissions: ['documents.send'], expires_in_days: 0 }],
        ['too many days', { permissions: ['documents.send'], expires_in_days: 3651 }],
      ] as const) {
        const bad = await refusal(
          api.connectedApps.generateKey(token, made.id, {
            permissions: [...body.permissions],
            expires_in_days: body.expires_in_days,
          }),
        );
        expect([bad.status, bad.code], why).toEqual([422, 'validation_failed']);
      }

      // A second key, named, that never expires, and only sends: what it may
      // do is its own permissions among the app's.
      const b = await api.connectedApps.generateKey(token, made.id, {
        name: 'Acme Money, sending only',
        permissions: ['documents.send'],
        expires_in_days: null,
      });
      expect(b.client_id).toMatch(/^fdvc_[A-Za-z0-9_-]{22}$/);
      expect(b.secret).toMatch(/^fdvs_[A-Za-z0-9_-]{43}$/);
      expect(b.key).toMatchObject({
        client_id: b.client_id,
        name: 'Acme Money, sending only',
        permissions: ['documents.send'],
        expires_at: null,
        revoked_at: null,
        state: 'live',
      });
      const plain = parseConnectionString(b.connection_string);
      expect(plain).toMatchObject({ client_id: b.client_id });
      expect(plain).not.toHaveProperty('secret');
      expect(parseConnectionString(b.connection_string_with_secret)).toMatchObject({
        client_id: b.client_id,
        secret: b.secret,
      });
      const appB = client(b.client_id, b.secret);
      const meB = await appB.me();
      expect(meB.scopes).toEqual(['documents.send']);
      expect(meB.key).toMatchObject({ name: 'Acme Money, sending only', expires_at: null });
      const narrower = await refusal(appB.list());
      expect([narrower.status, narrower.code]).toEqual([403, 'scope_not_granted']);

      // Two live at most: a third is refused.
      const third = await refusal(
        api.connectedApps.generateKey(token, made.id, {
          permissions: ['documents.send'],
          expires_in_days: 90,
        }),
      );
      expect([third.status, third.code]).toEqual([409, 'key_limit']);
      expect(APP_KEYS_MAX).toBe(2);

      // A wrong secret and a client ID nobody was given are the same refusal.
      const wrong = await refusal(client(a.clientId, b.secret).me());
      expect([wrong.status, wrong.code]).toEqual([401, 'app_key_invalid']);
      const unknown = await refusal(client(`fdvc_${'A'.repeat(22)}`, a.secret).me());
      expect([unknown.status, unknown.code]).toEqual([401, 'app_key_invalid']);

      // Revoked: its next request is refused, and its place is free again.
      await api.connectedApps.revokeKey(token, made.id, a.keyId);
      const revoked = await refusal(a.app.me());
      expect([revoked.status, revoked.code]).toEqual([401, 'app_key_revoked']);
      const c = await keyedApp(api, token, made, fetch, { days: 365 });
      expect((await c.app.me()).key.client_id).toBe(c.clientId);

      // Expired: refused, and its place free again too.
      if (ctx.expireAppKey) {
        await ctx.expireAppKey(c.clientId);
        const expired = await refusal(c.app.me());
        expect([expired.status, expired.code]).toEqual([401, 'app_key_expired']);
        const d = await keyedApp(api, token, made, fetch, { days: 7 });
        expect((await d.app.me()).state).toBe('active');
      }

      // Settings lists every key with its state, and never a secret.
      const listed = (await api.connectedApps.list(token)).items.find((x) => x.id === made.id);
      const states = Object.fromEntries((listed?.keys ?? []).map((k) => [k.client_id, k.state]));
      expect(states).toMatchObject({
        [a.clientId]: 'revoked',
        [b.client_id]: 'live',
        [c.clientId]: ctx.expireAppKey ? 'expired' : 'live',
      });
      const text = JSON.stringify(listed);
      for (const secret of [a.secret, b.secret, c.secret]) expect(text).not.toContain(secret);

      // An app removed: every key of it ends with it.
      await api.connectedApps.remove(token, made.id);
      const gone = await refusal(appB.me());
      expect([gone.status, gone.code]).toEqual([401, 'app_revoked']);
    },
  },
  {
    name: 'a connected app trades its API key for a short-lived access token and calls with Bearer; the key as Basic still works, deprecated; a new key lasts 90 days unless said (0.9.0-dev.72)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      const fetch = ctx.fetch;
      expect((await api.capabilities()).features.connected_app_tokens).toBe(true);
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const made = await api.connectedApps.create(token, {
        name: 'Acme Money',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes: ['documents.send', 'documents.read'],
      });
      // Nothing said of how long it lasts: 90 days. And each live key's own
      // connection string, its client ID in it and never its secret.
      const key = await api.connectedApps.generateKey(token, made.id, {
        permissions: ['documents.send'],
      });
      const left = Date.parse(key.key.expires_at as string) - Date.now();
      expect(left).toBeGreaterThan(89.9 * 864e5);
      expect(left).toBeLessThanOrEqual(90 * 864e5 + 60_000);
      const own = parseConnectionString(key.key.connection_string as string);
      expect(own).toMatchObject({ client_id: key.client_id });
      expect(own).not.toHaveProperty('secret');
      const listed = (await api.connectedApps.list(token)).items.find((a) => a.id === made.id);
      expect(listed?.keys.map((k) => k.connection_string)).toEqual([key.key.connection_string]);

      const base = api.http.baseUrl;
      const basic = basicAuthorization(key.client_id, key.secret);
      const call = (path: string, init: Partial<RequestInitLike> = {}) =>
        fetch(`${base}${path}`, { method: 'GET', headers: {}, ...init });
      const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
      const grant = (body: string, authorization = basic) =>
        call('/api/v1/apps/token', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });
      const codeOf = async (r: ResponseLike) =>
        [r.status, ((await r.json()) as { error?: { code?: string } }).error?.code] as const;

      // The key, as Basic, and the grant, as a form: a token, as RFC 6749 says it.
      const minted = await grant('grant_type=client_credentials');
      expect(minted.status).toBe(200);
      expect(minted.headers.get('cache-control')).toContain('no-store');
      const t = (await minted.json()) as AppAccessToken;
      expect(t).toEqual({
        access_token: expect.stringMatching(/^fdvt_[A-Za-z0-9_-]{43}$/) as string,
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'documents.send',
      });
      // Bearer on every other app route, and no word of deprecation.
      const viaToken = await call('/api/v1/apps/me', bearer(t.access_token));
      expect(viaToken.status).toBe(200);
      expect(viaToken.headers.get('deprecation')).toBeNull();
      expect(((await viaToken.json()) as AppMe).key.client_id).toBe(key.client_id);
      // The key as Basic there: still taken, and said to be deprecated.
      const viaBasic = await call('/api/v1/apps/me', { headers: { authorization: basic } });
      expect(viaBasic.status).toBe(200);
      expect(viaBasic.headers.get('deprecation')).toBe(APP_BASIC_DEPRECATION);
      // Client credentials alone, and the key alone on the token route.
      expect(await codeOf(await grant('grant_type=password'))).toEqual([
        400,
        'unsupported_grant_type',
      ]);
      expect(
        await codeOf(await grant('grant_type=client_credentials', `Bearer ${t.access_token}`)),
      ).toEqual([401, 'app_key_required']);
      // A token the vault never gave; one on a route that is not an app's;
      // and what it may do is its key's.
      expect(await codeOf(await call('/api/v1/apps/me', bearer(`fdvt_${'A'.repeat(43)}`)))).toEqual(
        [401, 'app_token_invalid'],
      );
      expect(await codeOf(await call('/api/v1/documents', bearer(t.access_token)))).toEqual([
        401,
        'app_key_not_accepted',
      ]);
      expect(await codeOf(await call('/api/v1/apps/documents', bearer(t.access_token)))).toEqual([
        403,
        'scope_not_granted',
      ]);
      // Ended by time: refused as expired, and the client asks for another.
      const app = createAppClient({
        url: base,
        clientId: key.client_id,
        secret: key.secret,
        fetch,
      });
      expect((await app.me()).key.client_id).toBe(key.client_id);
      if (ctx.expireAppTokens) {
        await ctx.expireAppTokens();
        expect(await codeOf(await call('/api/v1/apps/me', bearer(t.access_token)))).toEqual([
          401,
          'app_token_expired',
        ]);
        expect((await app.me()).key.client_id).toBe(key.client_id);
      }
      // The key revoked: its tokens end with it, at once, and it is given no more.
      const fresh = (await (await grant('grant_type=client_credentials')).json()) as AppAccessToken;
      await api.connectedApps.revokeKey(token, made.id, key.key.id);
      expect(await codeOf(await call('/api/v1/apps/me', bearer(fresh.access_token)))).toEqual([
        401,
        'app_key_revoked',
      ]);
      expect(await codeOf(await grant('grant_type=client_credentials'))).toEqual([
        401,
        'app_key_revoked',
      ]);
      const ended = await refusal(app.me());
      expect([ended.status, ended.code]).toEqual([401, 'app_key_revoked']);
      await api.connectedApps.remove(token, made.id);
    },
  },
  {
    name: 'a file of every byte value comes back exactly as the family sent it: a capture, a new version, a batch item accepted (CL3)',
    run: async (api) => {
      // The owner, with two-step sign-in on by now, as the connected app scenario signed them in.
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const pdf = (label: string) => ({
        bytes: everyByte(label),
        filename: `${label}.pdf`,
        contentType: 'application/pdf',
      });
      // A capture, sent as bytes with its details first.
      const first = pdf('cl3-capture');
      const form = multipartBody([
        {
          name: 'metadata',
          value: JSON.stringify({
            type_key: 'utility_bill',
            title: 'Every byte, captured',
            owner_member_id: owner.member_id,
            visibility: 'household',
          }),
        },
        { name: 'file', ...first },
      ]);
      const made = await api.capture(
        token,
        { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
        CL3_KEYS[0],
      );
      const got = await downloaded(api, token, made.version_id);
      expect(got.bytes).toEqual(first.bytes);
      expect(got.sha256).toBe(await sha256Hex(first.bytes));
      expect(got.disposition).toMatch(/^attachment/);
      // A new version of it.
      const second = pdf('cl3-version');
      const body = multipartBody([{ name: 'file', ...second }]);
      const version = await api.upload(
        token,
        made.document_id,
        { kind: 'bytes', bytes: body.bytes, contentType: body.contentType },
        CL3_KEYS[1],
      );
      expect(version.byte_size).toBe(second.bytes.length);
      const again = await downloaded(api, token, version.id);
      expect(again.bytes).toEqual(second.bytes);
      expect(again.sha256).toBe(await sha256Hex(second.bytes));
      // A batch's item, accepted.
      const third = pdf('cl3-batch');
      const batch = await api.createBatch(token, { name: 'Every byte' });
      const item = await api.addBatchItem(token, batch.id, { kind: 'bytes', ...third });
      expect(item.byte_size).toBe(third.bytes.length);
      const accepted = await api.acceptBatchItem(token, batch.id, item.id, {
        type_key: 'utility_bill',
        title: 'Every byte, accepted',
        owner_member_id: owner.member_id,
        visibility: 'household',
      });
      const filed = await downloaded(api, token, accepted.version_id);
      expect(filed.bytes).toEqual(third.bytes);
      expect(filed.sha256).toBe(await sha256Hex(third.bytes));
      await api.removeBatch(token, batch.id);
    },
  },
  {
    name: 'a connected app’s file of every byte value is kept exactly: its hash, and each download of it (CL3)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      if (!ctx.fileAppSend)
        throw new Error('the contract needs its vault to file what an app sent');
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const made = await api.connectedApps.create(token, {
        name: 'Every byte',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes: ['documents.send', 'documents.read', 'documents.download'],
      });
      const { app } = await keyedApp(api, token, made, ctx.fetch);
      const bytes = everyByte('cl3-app');
      const sum = await sha256Hex(bytes);
      const file = { bytes, filename: 'every-byte.pdf', contentType: 'application/pdf' };
      const sent = await app.send({
        externalId: 'every-byte-1',
        hints: { kind: 'utility_bill' },
        file,
      });
      // The vault hashed the bytes sent, exactly as they were.
      expect(sent.status).toBe(201);
      expect(sent.state.sha256).toBe(sum);
      expect(sent.state.byte_size).toBe(bytes.length);
      // Sent again, the same bytes: answered so, not refused as others would be.
      const replay = await app.send({ externalId: 'every-byte-1', file });
      expect(replay).toMatchObject({ status: 200, replayed: true });
      const doc = await ctx.fileAppSend(token, { id: made.id, name: made.name }, 'every-byte-1', {
        sha256: sum,
        bytes,
      });
      // The app's re-download of its send, and its download of the document.
      const resent = await app.sentFile('every-byte-1');
      expect(resent.status).toBe(200);
      expect(resent.bytes).toEqual(bytes);
      expect(await sha256Hex(resent.bytes)).toBe(sum);
      const read = await app.download(doc);
      expect(read.status).toBe(200);
      expect(read.bytes).toEqual(bytes);
      expect(await sha256Hex(read.bytes)).toBe(sum);
      // The family's ordinary download of the version it became.
      const newest = (await api.versions(token, doc)).items[0];
      expect(newest?.byte_size).toBe(bytes.length);
      const family = await downloaded(api, token, newest?.id as string);
      expect(family.bytes).toEqual(bytes);
      expect(family.sha256).toBe(sum);
      await api.connectedApps.remove(token, made.id);
    },
  },
  {
    name: 'a connected app keeps reading what its send made, whatever versions came since, and fetches its own file by its external id (0.9.0, APP6)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      if (!ctx.fileAppSend || !ctx.fileAppSendAsVersion) {
        throw new Error('the contract needs its vault to file what an app sent, as a version too');
      }
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      const scopes: AppScope[] = [
        'documents.send',
        'documents.read',
        'documents.download',
        'documents.delete',
      ];
      const first = await api.connectedApps.create(token, {
        name: 'Origin one',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes,
      });
      const second = await api.connectedApps.create(token, {
        name: 'Origin two',
        member_id: owner.member_id,
        allowed_kinds: ['utility_bill'],
        scopes,
      });
      const { app: one } = await keyedApp(api, token, first, ctx.fetch);
      const { app: two } = await keyedApp(api, token, second, ctx.fetch);
      const pdf = (marker: string) =>
        new TextEncoder().encode(`%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`);

      // The first app's send, filed as a document of its own.
      const mine = pdf('origin-one-1');
      const sentOne = await one.send({
        externalId: 'origin-one-1',
        hints: { kind: 'utility_bill' },
        file: { bytes: mine, filename: 'origin.pdf', contentType: 'application/pdf' },
      });
      const doc = await ctx.fileAppSend(token, { id: first.id, name: first.name }, 'origin-one-1', {
        sha256: sentOne.state.sha256 as string,
        bytes: mine,
      });
      const start = await one.changes();

      // The family adds a newer file: still the app's, which reads it as it
      // is now, and its feed says it changed.
      const family = pdf('origin-family-2');
      const body = multipartBody([
        { name: 'file', filename: 'family.pdf', contentType: 'application/pdf', bytes: family },
      ]);
      const newer = await api.upload(
        token,
        doc,
        { kind: 'bytes', bytes: body.bytes, contentType: body.contentType },
        ORIGIN_KEY,
      );
      const read = await one.document(doc);
      expect(read).toMatchObject({ own: true, external_id: 'origin-one-1' });
      expect(read.version?.id).toBe(newer.id);
      expect((await one.list({ own: true })).items.map((d) => d.id)).toContain(doc);
      const fed = await one.changes({ cursor: start.cursor });
      const line = fed.changes.find((c) => c.change === 'changed' && c.document.id === doc);
      expect(line?.change === 'changed' ? line.document.version?.id : null).toBe(newer.id);
      expect(fed.changes.some((c) => c.change === 'unavailable')).toBe(false);
      // The current file is the family's; its own exact file, by its external id.
      expect((await one.download(doc)).bytes).toEqual(family);
      expect((await one.sentFile('origin-one-1')).bytes).toEqual(mine);
      // Never the family's newer file to delete.
      const del = await refusal(one.delete(doc));
      expect([del.status, del.code]).toEqual([404, 'not_found']);

      // Another app's send filed into it as a version: the second app may
      // not read the document, but fetches its own file again; the first
      // still reads it, its current file now the second app's.
      const theirs = pdf('origin-two-1');
      const sentTwo = await two.send({
        externalId: 'origin-two-1',
        hints: { kind: 'utility_bill' },
        file: { bytes: theirs, filename: 'two.pdf', contentType: 'application/pdf' },
      });
      await ctx.fileAppSendAsVersion(
        token,
        { id: second.id, name: second.name },
        'origin-two-1',
        { sha256: sentTwo.state.sha256 as string, bytes: theirs },
        doc,
      );
      const notTwos = await refusal(two.document(doc));
      expect([notTwos.status, notTwos.code]).toEqual([404, 'not_found']);
      expect((await two.sentFile('origin-two-1')).bytes).toEqual(theirs);
      const still = await one.document(doc);
      expect(still).toMatchObject({ own: true, external_id: 'origin-one-1' });
      expect(still.version?.id).not.toBe(newer.id);
      expect((await one.download(doc)).bytes).toEqual(theirs);
      expect((await one.sentFile('origin-one-1')).bytes).toEqual(mine);
      await api.connectedApps.remove(token, first.id);
      await api.connectedApps.remove(token, second.id);
    },
  },
  {
    name: 'a connected app acts as itself: what nothing routes goes to its reviewer’s Inbox, what is about a person to them, the activity log names the app, a reviewer who cannot take it is 503 busy, and acting as a person is as before (0.9.0, APP8)',
    run: async (api, ctx) => {
      if (!ctx.fetch) throw new Error('the contract needs the fetch its vault answers on');
      if (!ctx.fileAppSend)
        throw new Error('the contract needs its vault to file what an app sent');
      const owner = connectedAppOwner;
      if (!owner) throw new Error('the connected app scenario runs first');
      const token = owner.access_token;
      // Connected without a person: itself, on at once, reviewed by the owner.
      const made = await api.connectedApps.create(token, {
        name: 'Acme Itself',
        allowed_kinds: ['utility_bill', 'bank_statement'],
        scopes: ['documents.send', 'documents.read'],
      });
      expect(made).toMatchObject({
        acts_as: 'app',
        member_id: null,
        member_name: null,
        reviewer_member_id: owner.member_id,
        reviewer_needed: false,
        state: 'active',
      });
      const { app } = await keyedApp(api, token, made, ctx.fetch);
      const me = await app.me();
      expect(me.acts_as).toBe('app');
      expect(me.acting_as).toEqual({ name: 'Acme Itself' });
      const file = (marker: string) => ({
        bytes: new TextEncoder().encode(`%PDF-1.4\n% ${marker}\n%%EOF\n`),
        filename: `${marker}.pdf`,
        contentType: 'application/pdf',
      });
      const lines = async () => (await api.activity(token)).items;

      // Nothing routes it: the reviewer's Inbox, filed from there; its file
      // names the app as who added it, and its line the app alone.
      const first = file('itself-1');
      const sent = await app.send({
        externalId: 'itself-1',
        hints: { kind: 'utility_bill' },
        file: first,
      });
      expect(sent.status).toBe(201);
      const doc = await ctx.fileAppSend(token, { id: made.id, name: made.name }, 'itself-1', {
        sha256: sent.state.sha256 as string,
        bytes: first.bytes,
      });
      expect((await app.status('itself-1')).state).toBe('filed');
      const history = (await api.versions(token, doc)).items;
      expect(history[0]).toMatchObject({ uploaded_by_name: 'Acme Itself', uploaded_by_app: true });
      const sentLine = (await lines()).find((l) =>
        /^Acme Itself sent a file to .+’s? Inbox$/.test(l.text),
      );
      expect(sentLine).toBeDefined();
      expect(sentLine?.actor_member_id).toBeNull();

      // About somebody who signs in: their Inbox, as APP5's.
      const rhea = await ctx.addSignIn(token, {
        name: 'Rhea Itself',
        email: 'rhea-itself@example.test',
        password: 'another correct horse',
        role: 'adult',
      });
      const routed = await app.send({
        externalId: 'itself-2',
        // By name: the fake's member ids are not UUIDs.
        // A person's paper: a utility bill is the household's, and never routed.
        hints: { kind: 'bank_statement', person: { name: 'Rhea Itself' } },
        file: file('itself-2'),
      });
      expect(routed.status).toBe(201);
      expect((await lines()).map((l) => l.text)).toContain(
        'Acme Itself sent a file to Rhea Itself’s Inbox',
      );

      // Rhea reviews it now (no approval), and is locked: what nothing
      // routes is refused for a moment; the owners are told once.
      const changed = await api.connectedApps.update(token, made.id, { reviewer_member_id: rhea });
      expect(changed).toMatchObject({ state: 'active', reviewer_member_id: rhea });
      await api.lockMember(token, rhea);
      for (const id of ['itself-3', 'itself-3']) {
        const busy = await refusal(
          app.send({ externalId: id, hints: { kind: 'utility_bill' }, file: file(id) }),
        );
        expect([busy.status, busy.code, busy.retriable]).toEqual([503, 'busy', true]);
      }
      const told = (await lines()).filter((l) =>
        l.text.startsWith('Acme Itself needs somebody to review what it sends'),
      );
      expect(told).toHaveLength(1);
      expect(
        (await api.connectedApps.list(token)).items.find((a) => a.id === made.id)?.reviewer_needed,
      ).toBe(true);
      await api.unlockMember(token, rhea);
      expect(
        (
          await app.send({
            externalId: 'itself-3',
            hints: { kind: 'utility_bill' },
            file: file('itself-3'),
          })
        ).status,
      ).toBe(201);

      // Acting as a person from now (the owner themselves): as before.
      const person = await api.connectedApps.update(token, made.id, {
        acts_as: 'person',
        member_id: owner.member_id,
      });
      expect(person).toMatchObject({
        acts_as: 'person',
        member_id: owner.member_id,
        reviewer_member_id: null,
        state: 'active',
      });
      expect((await app.me()).acts_as).toBe('person');
      expect(
        (
          await app.send({
            externalId: 'itself-4',
            hints: { kind: 'utility_bill' },
            file: file('itself-4'),
          })
        ).status,
      ).toBe(201);
      expect(
        (await lines()).some((l) => / via Acme Itself sent a file to their Inbox$/.test(l.text)),
      ).toBe(true);
      await api.connectedApps.remove(token, made.id);
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
