import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CHUNK_SIZE,
  decryptRange,
  EncryptStream,
  newKey,
  sealBytes,
  wrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import {
  appendAudit,
  withPrincipal,
  withScope,
  type Actor,
  type Db,
  type Schema,
  type Scope,
} from '@fdv/db';
import {
  can,
  maskEmail,
  SENDER_NOTE_MAX,
  SHARE_END_GRACE_MINUTES,
  SHARE_MAX_DAYS,
  SHARE_MIN_MINUTES,
  UPLOAD_CODE_MINUTES,
  UPLOAD_CODE_TRIES,
  UPLOAD_PASSWORD_MIN,
  UPLOAD_REQUEST_ITEM_LABEL_MAX,
  UPLOAD_REQUEST_ITEMS_MAX,
  UPLOAD_REQUEST_MAX_BYTES,
  UPLOAD_REQUEST_MAX_FILES,
  UPLOAD_REQUEST_MESSAGE_MAX,
  UPLOAD_REQUEST_TITLE_MAX,
  INCOMING_HOUSEHOLD_MAX_BYTES,
  uploadRequestTypes,
  type CreatedUploadRequest,
  type DropCodeSent,
  type DropFile,
  type DropFinished,
  type DropPreview,
  type DropSession,
  type UploadProtection,
  type UploadRequestState,
  type UploadRequestView,
} from '@fdv/shared';
import { readAll, type StorageAdapter } from '@fdv/storage';
import argon2 from 'argon2';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { truncatedIp } from '../documents/shares.js';
import type { Enqueue } from '../documents/service.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { inspectOffice } from './office.js';

/**
 * Asking somebody outside the family to send documents (5.21, #12).
 *
 * An owner or an adult makes a request; the vault answers with a link,
 * `/drop#<token>`, for the accountant or the solicitor. The token is 32
 * random bytes and is never kept, only its SHA-256. It rides in the URL's
 * fragment, which no server sees; the page posts it in a body.
 *
 * The link is write-only. Whoever holds it sees whose vault it is and who
 * asked; after Open, what they are asked for (the title, the message, the
 * named slots) and the files they have sent from this browser — never the
 * vault, never another sender's files, never the person or the kind of
 * document the requester guessed at for the reviewer.
 *
 * Open is the one step that is counted: a password and an emailed code are
 * tried against one counter of ten for the request's life (A23), reserved
 * before they are checked, so tries made at once cannot get past it; a
 * visit is counted within `max_visits` by one guarded statement; and a
 * session cookie, whose hash is all the vault keeps, carries the rest.
 *
 * Every request of the flow asks the request again as it is now: taken
 * back, closed, paused, past its end, locked, or its requester no longer an
 * owner or an adult (A39) — each answers as a link that does not exist. The
 * database asks the same (app_live_upload_request(), 0044).
 *
 * A file is sniffed from its bytes against what the request takes (A40),
 * counted against every cap as it arrives and cut off at the first it
 * passes, encrypted under the reviewer's key from its first byte — the
 * requester's own member key, or the adults key (A43) — and written straight
 * to its object while its row says `uploading`. Only a whole file, within
 * every cap and of a kind the request takes, is committed (`received`). It
 * then waits, apart from the documents, for somebody to review it (5.23).
 */

const MAX_ATTEMPTS = 10;
const ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The cookies, and the one path they are sent to. A session's is named for
 * its request (`fdv_drop_s_<request id>`), so a browser that opens two
 * requests keeps both; the device cookie is one per browser, minted once,
 * and each request that is for "this device only" binds to it and its own
 * id, so opening a second never unbinds the first.
 */
export const DROP_COOKIE_PREFIX = 'fdv_drop_s_';
export const DROP_DEVICE_COOKIE = 'fdv_drop_device';
export const DROP_COOKIE_PATH = '/api/v1/drop';
/** Which request a page is asking about, when its browser holds more than one session. */
export const DROP_REQUEST_HEADER = 'x-fdv-drop-request';
/** The device cookie lasts as long as the longest request can. */
export const DROP_DEVICE_MAX_AGE = SHARE_MAX_DAYS * 86_400;

/** A session cookie's name, for its request. */
export const dropCookieName = (requestId: string) =>
  `${DROP_COOKIE_PREFIX}${requestId.replace(/-/g, '').toLowerCase()}`;
/** A session lasts 30 minutes from its last use, and 4 hours at most (A26, as a link's). */
export const DROP_SESSION_IDLE_MS = 30 * 60_000;
export const DROP_SESSION_MAX_MS = 4 * 3_600_000;

/** The worker's job that emails a code (operator mail only, A21); its JOBS.uploadCode. */
export const UPLOAD_CODE_JOB = 'upload.code';
/** At most this many codes a quarter of an hour, and a day, for one request. */
const CODES_PER_15_MIN = 3;
const CODES_PER_DAY = 10;

const SNIFF_BYTES = 4100;

const linkToken = z.string().min(16).max(256);

export const createBody = z
  .object({
    title: z.string().trim().min(1).max(UPLOAD_REQUEST_TITLE_MAX),
    message: z.string().trim().max(UPLOAD_REQUEST_MESSAGE_MAX).nullable().optional(),
    items: z
      .array(z.string().trim().min(1).max(UPLOAD_REQUEST_ITEM_LABEL_MAX))
      .max(UPLOAD_REQUEST_ITEMS_MAX)
      .optional(),
    recipient_label: z.string().trim().max(80).nullable().optional(),
    recipient_email: z.string().trim().email().max(254).nullable().optional(),
    expires_at: z.string().datetime({ offset: true }),
    with_password: z.boolean().optional(),
    password: z.string().min(UPLOAD_PASSWORD_MIN).max(64).optional(),
    email_code: z.boolean().optional(),
    this_device_only: z.boolean().optional(),
    max_visits: z.number().int().min(1).max(1000).nullable().optional(),
    max_files: z.number().int().min(1).max(UPLOAD_REQUEST_MAX_FILES).optional(),
    max_total_bytes: z.number().int().min(1).max(UPLOAD_REQUEST_MAX_BYTES).optional(),
    accept_types: z.enum(['standard', 'office']).optional(),
    review_by: z.enum(['me', 'adults']).optional(),
    suggested_member_id: z.string().uuid().nullable().optional(),
    suggested_type_key: z.string().min(1).max(64).nullable().optional(),
    close_after_submit: z.boolean().optional(),
  })
  .strict();

export const dropTokenBody = z.object({ token: linkToken }).strict();

export const dropUnlockBody = z
  .object({
    token: linkToken,
    password: z.string().max(64).optional(),
    code: z.string().trim().max(12).optional(),
  })
  .strict();

export const dropFinishBody = z
  .object({ note: z.string().max(SENDER_NOTE_MAX).nullable().optional() })
  .strict();

export interface UploadRequestOptions {
  /** FDV_SHARE_MAX_DAYS: the longest a request may last (A20). */
  maxDays?: number;
  /** FDV_MAX_UPLOAD_BYTES: the largest one file may be. */
  maxFileBytes: number;
  /** FDV_PUBLIC_URL: the public-only site the link starts with, when there is one. */
  publicUrl?: string | null;
  /** Whether whoever runs the server has given it a mail server (FDV_SMTP_URL, A21). */
  operatorMail?: boolean;
  /** The server's key for a code's HMAC: a dump alone cannot check a code. */
  codeKey: Buffer;
  /** The key a code is sealed under on its way to the worker. */
  codeJobKey: Buffer;
  enqueue?: Enqueue;
  /** How a requester is told their request was locked. */
  alert?: (input: AlertRequest) => Promise<void>;
  /** The household's files waiting for review, in bytes, at most (tests shorten it). */
  householdMaxBytes?: number;
}

/** A file on its way in, as the route hands it over. */
export interface DropUpload {
  filename: string;
  stream: Readable;
  /** Which of the request's items the sender put it against, if any. */
  itemId: string | null;
  /** True when the multipart parser cut the file off at its limit. */
  truncated: () => boolean;
  /** The route's last check, once the file has arrived: nothing may follow it. */
  finished: () => Promise<void>;
  /** How long the upload said it was (its Content-Length), if it said: the room reserved. */
  declaredBytes: number | null;
}

type RequestRow = Selectable<Schema['upload_request']>;

/** Why Open did not open. */
type Refusal = 'used up' | 'other device' | 'gone' | 'locked' | 'wrong' | 'code used';

/** A transaction asked for by whoever holds one request's link: never anybody else. */
type UploadScope = Scope & { householdId: string; actor: Extract<Actor, { kind: 'upload' }> };

/** A session made by Open: the cookie, once, its name, and what it opened. */
export interface DropUnlocked {
  cookie: string;
  cookieName: string;
  /** Seconds until the session ends at the latest: the cookie's Max-Age. */
  maxAge: number;
  /** "This device only": the browser's device cookie, when this Open minted it. */
  device?: { cookie: string; maxAge: number };
  session: DropSession;
}

/** How a device cookie binds one request: its hash with the request's id. */
const deviceBinding = (cookie: string, requestId: string) => hash(`${cookie}:${requestId}`);

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest();

// ---------------------------------------------------------------- refusals

/** Every dead end a sender can reach answers the same: no such link. */
const gone = () =>
  new ApiError(
    404,
    'link_not_valid',
    'That link is not valid any more. Ask whoever sent it for a new one.',
  );

/** 404 for a teen or a viewer: requests are not something they can know of. */
const nothingHere = () => new ApiError(404, 'not_found', 'That page does not exist.');

const usedUp = () =>
  new ApiError(
    410,
    'request_used_up',
    'This link has been opened as many times as it allows, so it cannot be opened again. Ask whoever sent it for a new one.',
  );

const secretWrong = (left: number) =>
  new ApiError(
    401,
    'secret_wrong',
    left > 0
      ? 'That is not right. Check what you were sent, and try again.'
      : 'That was wrong too many times, so the link has stopped working.',
  );

const codeUsed = () =>
  new ApiError(
    409,
    'code_used',
    'That code has just been used to open this link. Ask for a new code to open it again.',
  );

const otherDevice = () =>
  new ApiError(
    403,
    'other_device',
    'This link was opened on another device, and works only there. Ask whoever sent it for a new one.',
  );

const sessionEnded = () =>
  new ApiError(
    401,
    'drop_session_ended',
    'This page has been open too long, or was opened somewhere else. Open the link you were sent again.',
  );

const tooLarge = (what: string) => new ApiError(413, 'too_large', what);

const wrongType = (accept: 'standard' | 'office') =>
  new ApiError(
    415,
    'unsupported_type',
    accept === 'office'
      ? 'That kind of file cannot be sent here. PDFs, photos, and Word or Excel files are fine.'
      : 'That kind of file cannot be sent here. PDFs and photos are fine.',
  );

const macros = () =>
  new ApiError(
    415,
    'macros_refused',
    "Word and Excel files with macros, or that load something from elsewhere, can't be sent here. Save it as an ordinary Word or Excel file, or as a PDF, and send that.",
  );

const storageUnreachable = (detail: string) =>
  new ApiError(503, 'storage_unreachable', 'The file could not be saved just now. Try again.', {
    detail,
    retriable: true,
    retryAfter: 30,
  });

const endRefused = (message: string) => new ApiError(422, 'expiry_out_of_range', message);

/**
 * A file's name as sent, made safe to show a reviewer: its last path part,
 * no control or direction characters, at most 200 characters. Never logged.
 */
export function safeName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const clean = last
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...clean].slice(0, 200).join('');
  return cut && cut !== '.' && cut !== '..' ? cut : 'file';
}

/** A password the vault makes up: three groups of four, with no look-alike letters. */
function madePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () =>
    Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

function protectionOf(r: {
  secret_hash: string | null;
  email_code: boolean;
  this_device_only: boolean;
}): UploadProtection[] {
  const out: UploadProtection[] = [];
  if (r.secret_hash) out.push('password');
  if (r.email_code) out.push('email_code');
  if (r.this_device_only) out.push('this_device');
  return out;
}

function stateOf(r: RequestRow): UploadRequestState {
  if (r.revoked_at) return 'revoked';
  if (r.closed_at) return 'closed';
  if (r.attempts >= MAX_ATTEMPTS) return 'locked';
  if (r.expires_at.getTime() <= Date.now()) return 'expired';
  if (r.paused_at) return 'paused';
  if (r.max_visits !== null && r.visits_used >= r.max_visits) return 'used_up';
  return 'active';
}

/**
 * Whether a request has ended for good: its address is cleared then. Used
 * up too: nothing gives a request more visits.
 */
const ended = (r: RequestRow) => {
  const s = stateOf(r);
  return s === 'revoked' || s === 'closed' || s === 'locked' || s === 'expired' || s === 'used_up';
};

export class UploadRequestService {
  private readonly maxDays: number;
  private readonly enqueue: Enqueue;
  private readonly alert: (input: AlertRequest) => Promise<void>;
  private readonly householdMax: number;

  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    private readonly opts: UploadRequestOptions,
  ) {
    this.maxDays = Math.min(opts.maxDays ?? SHARE_MAX_DAYS, SHARE_MAX_DAYS);
    this.enqueue = opts.enqueue ?? (async () => undefined);
    this.alert = opts.alert ?? (async () => undefined);
    this.householdMax = opts.householdMaxBytes ?? INCOMING_HOUSEHOLD_MAX_BYTES;
  }

  /** The largest one file may be, before what is left of a request. */
  get maxFileBytes(): number {
    return this.opts.maxFileBytes;
  }

  /** Whether an emailed code can be offered: only with operator mail (A21). */
  get emailCodeAvailable(): boolean {
    return this.opts.operatorMail === true;
  }

  // ============================================================ the family

  /** Requests are the owners' and adults'; anybody else is told there is nothing here. */
  private mayAsk(p: Principal): void {
    if (!can(p.role, 'upload_request.create')) throw nothingHere();
  }

  /** When a request ends: at least 5 minutes ahead, at most the vault's longest (A20). */
  private endOf(expiresAt: string): Date {
    const end = new Date(expiresAt);
    const now = Date.now();
    if (Number.isNaN(end.getTime())) throw endRefused('That is not a date and time.');
    if (end.getTime() < now + SHARE_MIN_MINUTES * 60_000) {
      throw endRefused(`Choose a time at least ${SHARE_MIN_MINUTES} minutes from now.`);
    }
    if (end.getTime() > now + this.maxDays * 864e5 + SHARE_END_GRACE_MINUTES * 60_000) {
      throw endRefused(`A request can last ${this.maxDays} days at most.`);
    }
    return end;
  }

  async create(
    p: Principal,
    input: z.infer<typeof createBody>,
    meta: RequestMeta,
  ): Promise<CreatedUploadRequest> {
    this.mayAsk(p);
    const expiresAt = this.endOf(input.expires_at);
    if (input.with_password && input.password !== undefined) {
      throw new ApiError(
        422,
        'validation_failed',
        'Ask for a password to be made, or type one: not both.',
      );
    }
    const email = input.recipient_email?.trim() || null;
    if (input.email_code) {
      // Operator mail only: the household's own can be pointed anywhere (A21).
      if (!this.emailCodeAvailable) {
        throw new ApiError(
          422,
          'email_code_unavailable',
          'This vault cannot send email codes: whoever runs it has not given it a mail server.',
        );
      }
      if (!email) {
        throw new ApiError(422, 'validation_failed', 'Give the address the code should go to.', {
          detail: 'recipient_email',
        });
      }
    }
    const token = randomBytes(32).toString('base64url');
    const password = input.with_password ? madePassword() : (input.password ?? null);
    const secretHash = password ? await argon2.hash(password, ARGON2) : null;
    const items = input.items ?? [];

    const id = await withPrincipal(this.db, p, async (trx) => {
      if (input.suggested_member_id) {
        const m = await trx
          .selectFrom('member')
          .select('id')
          .where('id', '=', input.suggested_member_id)
          .executeTakeFirst();
        if (!m) {
          throw new ApiError(422, 'validation_failed', 'That person is not in the family.', {
            detail: 'suggested_member_id',
          });
        }
      }
      if (input.suggested_type_key) {
        const t = await trx
          .selectFrom('effective_document_type')
          .select('key')
          .where('key', '=', input.suggested_type_key)
          .where((eb) =>
            eb.or([eb('household_id', 'is', null), eb('household_id', '=', p.householdId)]),
          )
          .executeTakeFirst();
        if (!t) {
          throw new ApiError(422, 'validation_failed', 'The vault has no such kind of document.', {
            detail: 'suggested_type_key',
          });
        }
      }
      const row = await trx
        .insertInto('upload_request')
        .values({
          household_id: p.householdId,
          created_by: p.accountId,
          requester_member_id: p.memberId,
          title: input.title,
          message: input.message?.trim() || null,
          recipient_label: input.recipient_label?.trim() || null,
          recipient_email: email,
          token_hash: hash(token),
          secret_hash: secretHash,
          email_code: input.email_code ?? false,
          this_device_only: input.this_device_only ?? false,
          expires_at: expiresAt,
          max_visits: input.max_visits ?? null,
          max_files: input.max_files ?? UPLOAD_REQUEST_MAX_FILES,
          max_total_bytes: input.max_total_bytes ?? UPLOAD_REQUEST_MAX_BYTES,
          accept_types: input.accept_types ?? 'standard',
          review_by: input.review_by ?? 'me',
          suggested_member_id: input.suggested_member_id ?? null,
          suggested_type_key: input.suggested_type_key ?? null,
          close_after_submit: input.close_after_submit ?? false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (items.length) {
        await trx
          .insertInto('upload_request_item')
          .values(
            items.map((label, i) => ({
              household_id: p.householdId,
              request_id: row.id,
              position: i + 1,
              label,
            })),
          )
          .execute();
      }
      // No title, message or address in the permanent log: whom it is for,
      // who reviews, and what protects it.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'upload_request.created',
        objectType: 'upload_request',
        objectId: row.id,
        detail: {
          recipient_label: input.recipient_label?.trim() || null,
          review_by: input.review_by ?? 'me',
          expires_at: expiresAt.toISOString(),
          protection: protectionOf({
            secret_hash: secretHash,
            email_code: input.email_code ?? false,
            this_device_only: input.this_device_only ?? false,
          }),
        },
        ip: meta.ip,
      });
      return row.id;
    });

    const request = (await this.list(p)).find((r) => r.id === id) as UploadRequestView;
    const link_url = this.opts.publicUrl
      ? `${this.opts.publicUrl.replace(/\/+$/, '')}/drop#${token}`
      : null;
    return password && input.with_password
      ? { request, link_token: token, link_url, password }
      : { request, link_token: token, link_url };
  }

  /**
   * The requests the reader reviews: their own, and those for any adult.
   * Another adult's review-by-me request is not there for them — the
   * database keeps it from them (0044), whatever this asks.
   */
  async list(p: Principal): Promise<UploadRequestView[]> {
    this.mayAsk(p);
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('upload_request')
        .leftJoin('member', 'member.id', 'upload_request.requester_member_id')
        .selectAll('upload_request')
        .select('member.display_name as requested_by_name')
        .orderBy('upload_request.created_at', 'desc')
        .execute();
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const items = await trx
        .selectFrom('upload_request_item')
        .select(['id', 'request_id', 'label', 'position'])
        .where('request_id', 'in', ids)
        .orderBy('position')
        .execute();
      const files = await trx
        .selectFrom('incoming_file')
        .select(['request_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('request_id', 'in', ids)
        .where('state', '<>', 'uploading')
        .groupBy('request_id')
        .execute();
      return rows.map((r) => ({
        ...this.view(r, p),
        requested_by_name: r.requested_by_name,
        items: items
          .filter((i) => i.request_id === r.id)
          .map((i) => ({ id: i.id, label: i.label })),
        files_received: Number(files.find((f) => f.request_id === r.id)?.n ?? 0),
      }));
    });
  }

  private view(r: RequestRow, p: Principal): UploadRequestView {
    return {
      id: r.id,
      title: r.title,
      message: r.message,
      items: [],
      recipient_label: r.recipient_label,
      recipient_email: ended(r) ? null : r.recipient_email,
      requested_by_name: null,
      mine: r.created_by === p.accountId,
      created_at: r.created_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
      protection: protectionOf(r),
      max_visits: r.max_visits,
      visits_used: r.visits_used,
      max_files: r.max_files,
      files_used: r.files_used,
      max_total_bytes: Number(r.max_total_bytes),
      bytes_used: Number(r.bytes_used),
      accept_types: r.accept_types,
      review_by: r.review_by,
      suggested_member_id: r.suggested_member_id,
      suggested_type_key: r.suggested_type_key,
      close_after_submit: r.close_after_submit,
      state: stateOf(r),
      paused_reason: r.paused_reason,
      closed_reason: r.closed_reason,
      files_received: 0,
    };
  }

  /**
   * Taken back: the link opens nothing from now on, its sessions and codes
   * end, and the address it would have sent a code to is cleared. Files
   * already sent stay, for review.
   */
  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    this.mayAsk(p);
    await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .updateTable('upload_request')
        .set({ revoked_at: new Date(), revoked_by: p.accountId, recipient_email: null })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new ApiError(404, 'not_found', 'That request does not exist.');
      await trx.deleteFrom('upload_session').where('request_id', '=', id).execute();
      await trx.deleteFrom('upload_code').where('request_id', '=', id).execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'upload_request.revoked',
        objectType: 'upload_request',
        objectId: id,
        ip: meta.ip,
      });
    });
  }

  /**
   * The requests a restore paused that the reader may decide about (A55):
   * an owner, every one they can see, to turn back on; anybody else who may
   * ask, their own, to take back. An adult's review-by-me request is theirs
   * alone, so no owner sees it: it stays paused, and they take it back and
   * make a new one, as a link to an Only me document does (5.16).
   */
  async paused(p: Principal): Promise<UploadRequestView[]> {
    if (!can(p.role, 'upload_request.create')) return [];
    const owner = can(p.role, 'restore.review');
    return (await this.list(p)).filter((r) => r.state === 'paused' && (owner || r.mine));
  }

  /** Turns a paused request back on: its link opens again, as it did before. Owners only. */
  async resume(p: Principal, id: string, meta: RequestMeta): Promise<UploadRequestView> {
    this.mayAsk(p);
    requireCapability(p, 'restore.review');
    await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .updateTable('upload_request')
        .set({ paused_at: null, paused_reason: null })
        .where('id', '=', id)
        .where('paused_at', 'is not', null)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new ApiError(404, 'not_found', 'That paused request does not exist.');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'upload_request.resumed',
        objectType: 'upload_request',
        objectId: id,
        ip: meta.ip,
      });
    });
    return (await this.list(p)).find((r) => r.id === id) as UploadRequestView;
  }

  // ============================================================ the sender

  /**
   * Who asks for a token's request: whoever holds it. Finding which request
   * that is, by the token's hash, is the one question asked with the
   * owner's rights (upload_request_find, 0044) — and only a request that can
   * be used is found. Everything after asks as the upload link.
   */
  private async scopeOf(token: string): Promise<UploadScope> {
    const r = await sql<{ household_id: string; request_id: string }>`
      select household_id, request_id from upload_request_find(${hash(token)})
    `.execute(this.db);
    const found = r.rows[0];
    if (!found) throw gone();
    return {
      householdId: found.household_id,
      actor: { kind: 'upload', requestId: found.request_id },
    };
  }

  /**
   * The request, if it may be used now: not taken back, closed, paused, past
   * its end or locked, and its requester still an owner or an adult of the
   * household (A39; locked from 5.28 joins them). The database gives an
   * upload link no row otherwise; this asks again, in words.
   */
  private async live(
    trx: Db,
    requestId: string,
    opts: { lock?: boolean } = {},
  ): Promise<RequestRow> {
    const query = trx.selectFrom('upload_request').selectAll().where('id', '=', requestId);
    const row = await (opts.lock ? query.forUpdate() : query).executeTakeFirst();
    if (!row) throw gone();
    if (row.revoked_at || row.closed_at || row.paused_at) throw gone();
    if (row.expires_at.getTime() <= Date.now()) throw gone();
    if (row.attempts >= MAX_ATTEMPTS) throw gone();
    const asker = await trx
      .selectFrom('account_household')
      .select(['role', 'member_id'])
      .where('account_id', '=', row.created_by)
      .executeTakeFirst();
    if (!asker || asker.member_id !== row.requester_member_id) throw gone();
    if (!can(asker.role, 'upload_request.create')) throw gone();
    // 5.28: a requester whose sign-in is locked asks for nothing either;
    // that state arrives with 5.28, and its check goes here.
    return row;
  }

  /** Whose vault, and who asked. */
  private async names(trx: Db, r: RequestRow) {
    const household = await trx.selectFrom('household').select('name').executeTakeFirstOrThrow();
    const asker = await trx
      .selectFrom('member')
      .select('display_name')
      .where('id', '=', r.requester_member_id)
      .executeTakeFirst();
    return { household_name: household.name, requested_by: asker?.display_name ?? null };
  }

  /**
   * What the page shows before anybody presses anything: whose vault and who
   * asked, what Open will ask for, and until when. Not what is asked for or
   * why — the title, the message and the slots wait for Open — and nothing
   * is counted or written down: a link scanner fetching the page is not
   * somebody opening it.
   */
  async preview(token: string): Promise<DropPreview> {
    const scope = await this.scopeOf(token);
    return withScope(this.db, scope, async (trx) => {
      const r = await this.live(trx, scope.actor.requestId);
      if (r.max_visits !== null && r.visits_used >= r.max_visits) throw usedUp();
      return {
        ...(await this.names(trx, r)),
        protection: protectionOf(r),
        expires_at: r.expires_at.toISOString(),
      };
    });
  }

  /**
   * An emailed code (A21, as 5.20's for a link): six digits, to the address
   * the requester typed and nowhere else — the sender never types one — by
   * the operator's mail server alone. At most 3 a quarter of an hour and
   * 10 a day. Kept as an HMAC under the server's key; the worker is handed
   * it sealed, and the email carries no link and no title.
   */
  async sendCode(token: string, meta: RequestMeta): Promise<DropCodeSent> {
    const scope = await this.scopeOf(token);
    const { householdId } = scope;
    const out = await withScope(this.db, scope, async (trx) => {
      const r = await this.live(trx, scope.actor.requestId);
      if (!r.email_code || !r.recipient_email || !this.emailCodeAvailable) {
        throw new ApiError(422, 'no_email_code', 'This link does not use an emailed code.');
      }
      if (r.max_visits !== null && r.visits_used >= r.max_visits) throw usedUp();
      // One code at a time is counted: two asking at once wait for each other.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`upload-code:${r.id}`}, 0))`.execute(
        trx,
      );
      const now = Date.now();
      const sent = await trx
        .selectFrom('upload_code')
        .select(['sent_at'])
        .where('request_id', '=', r.id)
        .where('sent_at', '>', new Date(now - 864e5))
        .execute();
      const lately = sent.filter((s) => s.sent_at.getTime() > now - 15 * 60_000).length;
      if (lately >= CODES_PER_15_MIN || sent.length >= CODES_PER_DAY) {
        throw new ApiError(
          429,
          'too_many_codes',
          'Several codes have been sent already. Use the newest one, or wait a while and ask again.',
          { retriable: true, retryAfter: 15 * 60 },
        );
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(now + UPLOAD_CODE_MINUTES * 60_000);
      const row = await trx
        .insertInto('upload_code')
        .values({
          household_id: householdId,
          request_id: r.id,
          code_hash: this.codeHash(r.id, code),
          sent_at: new Date(now),
          expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const sentTo = maskEmail(r.recipient_email);
      await appendAudit(trx, {
        householdId,
        actorLabel: this.actorLabel(r),
        action: 'upload_request.code_sent',
        objectType: 'upload_request',
        objectId: r.id,
        detail: { sent_to: sentTo },
        ip: truncatedIp(meta.ip),
      });
      return { codeId: row.id, code, sentTo, expiresAt, requestId: r.id };
    });
    await this.enqueue(UPLOAD_CODE_JOB, {
      household_id: householdId,
      request_id: out.requestId,
      code_id: out.codeId,
      sealed: sealBytes(
        this.opts.codeJobKey,
        Buffer.from(out.code, 'utf8'),
        `upload-code:${out.codeId}`,
      ).toString('base64'),
    });
    return { sent_to: out.sentTo, expires_at: out.expiresAt.toISOString() };
  }

  private codeHash(requestId: string, code: string): Buffer {
    return createHmac('sha256', this.opts.codeKey).update(`${requestId}:${code}`).digest();
  }

  /**
   * Open: the one step that is counted and written down. The whole of it
   * holds the request's row, taken first, so Opens pressed at once wait for
   * each other whole and never take their locks in another order. This
   * device only first: a browser's device cookie, bound to this request by
   * the first Open that works; then the password and the code, every wrong
   * one answered alike and counted against one counter of ten (A23); then
   * the visit, within `max_visits`; then a session for this browser.
   */
  async unlock(
    input: z.infer<typeof dropUnlockBody>,
    deviceCookie: string | undefined,
    meta: RequestMeta,
  ): Promise<DropUnlocked> {
    const scope = await this.scopeOf(input.token);
    const { householdId } = scope;
    const outcome = await withScope(this.db, scope, async (trx) => {
      const r = await this.live(trx, scope.actor.requestId, { lock: true });
      const refused = (why: Refusal, left = 0) => ({ refused: why, left, requester: r.created_by });
      if (r.max_visits !== null && r.visits_used >= r.max_visits) return refused('used up');
      const browser = deviceCookie && deviceCookie.length <= 128 ? deviceCookie : null;
      let binding: Buffer | null = null;
      let minted: string | undefined;
      if (r.this_device_only) {
        if (r.device_hash) {
          if (!browser || !timingSafeEqual(deviceBinding(browser, r.id), r.device_hash)) {
            return refused('other device');
          }
        } else {
          // One device cookie per browser: made now only if it has none.
          const cookie = browser ?? (minted = randomBytes(32).toString('base64url'));
          binding = deviceBinding(cookie, r.id);
        }
      }
      const tried = await this.trySecrets(trx, r, input, meta);
      if (tried === 'gone' || tried === 'locked' || tried === 'code used') return refused(tried);
      if (tried !== 'right') return refused('wrong', tried.wrong);

      const counted = await trx
        .updateTable('upload_request')
        .set((eb) => ({ visits_used: eb('visits_used', '+', 1) }))
        .where('id', '=', r.id)
        .where((eb) =>
          eb.or([eb('max_visits', 'is', null), eb('visits_used', '<', eb.ref('max_visits'))]),
        )
        .returning('visits_used')
        .executeTakeFirst();
      if (!counted) return refused('used up');
      if (binding) {
        // Bound once, by one Open: the row is held, and this says so again.
        const bound = await trx
          .updateTable('upload_request')
          .set({ device_hash: binding })
          .where('id', '=', r.id)
          .where('device_hash', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!bound) throw otherDevice();
      }

      const cookie = randomBytes(32).toString('base64url');
      const now = Date.now();
      const expiresAt = new Date(Math.min(now + DROP_SESSION_MAX_MS, r.expires_at.getTime()));
      await trx
        .deleteFrom('upload_session')
        .where('request_id', '=', r.id)
        .where('expires_at', '<=', new Date(now))
        .execute();
      const verified: string[] = [];
      if (r.secret_hash) verified.push('password');
      if (r.email_code) verified.push('email_code');
      if (r.this_device_only) verified.push('this_device');
      const made = await trx
        .insertInto('upload_session')
        .values({
          household_id: householdId,
          request_id: r.id,
          cookie_hash: hash(cookie),
          verified_by: verified,
          created_at: new Date(now),
          last_seen_at: new Date(now),
          expires_at: expiresAt,
          ip: truncatedIp(meta.ip),
          user_agent: meta.userAgent?.slice(0, 512) ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(trx, {
        householdId,
        actorLabel: this.actorLabel(r),
        action: 'upload_request.opened',
        objectType: 'upload_request',
        objectId: r.id,
        detail: { user_agent: meta.userAgent ?? null },
        ip: truncatedIp(meta.ip),
      });
      const fresh = { ...r, visits_used: counted.visits_used };
      const session = await this.sessionView(trx, fresh, made.id, expiresAt);
      return { cookie, requestId: r.id, expiresAt, minted, session } as const;
    });
    if ('refused' in outcome) {
      switch (outcome.refused) {
        case 'used up':
          throw usedUp();
        case 'other device':
          throw otherDevice();
        case 'gone':
          throw gone();
        case 'code used':
          throw codeUsed();
        case 'locked':
          await this.alert({
            householdId,
            accountIds: [outcome.requester],
            subject: 'A request you sent has stopped working',
            body:
              'A wrong password or code was typed ten times on a link you sent asking for ' +
              'documents, so it has stopped working. Make a new request if they still need ' +
              'to send them.',
          });
          throw secretWrong(0);
        case 'wrong':
          throw secretWrong(outcome.left);
      }
    }
    return {
      cookie: outcome.cookie,
      cookieName: dropCookieName(outcome.requestId),
      maxAge: Math.max(1, Math.floor((outcome.expiresAt.getTime() - Date.now()) / 1000)),
      ...(outcome.minted
        ? { device: { cookie: outcome.minted, maxAge: DROP_DEVICE_MAX_AGE } }
        : {}),
      session: outcome.session,
    };
  }

  /**
   * The password, then the code, as one try of the request's one counter
   * (A23), on the row Open holds: tries at once wait for it, so no more
   * than ten are ever made. Right, nothing is counted. Wrong, in either,
   * the try is counted, and the answer does not say which was wrong; the
   * tenth locks the request, once — its sessions and codes end, its address
   * is cleared (upload_request_ended_forgets, 0044), and the log says so. A
   * code this request has just been opened with is a second press of Open,
   * not a guess: refused as used, and not counted.
   */
  private async trySecrets(
    trx: Db,
    r: RequestRow,
    input: z.infer<typeof dropUnlockBody>,
    meta: RequestMeta,
  ): Promise<'right' | 'gone' | 'locked' | 'code used' | { wrong: number }> {
    if (!r.secret_hash && !r.email_code) return 'right';
    if (r.attempts >= MAX_ATTEMPTS) return 'gone';
    let right = true;
    if (r.secret_hash) {
      right = input.password
        ? await argon2.verify(r.secret_hash, input.password).catch(() => false)
        : false;
    }
    // The code only after the password (A23): a wrong password never uses
    // up a code's own tries.
    if (right && r.email_code) {
      const given = input.code?.replace(/\s+/g, '') ?? '';
      const presented = /^\d{6}$/.test(given) ? this.codeHash(r.id, given) : null;
      const code = await trx
        .selectFrom('upload_code')
        .select(['id', 'code_hash'])
        .where('request_id', '=', r.id)
        .where('used_at', 'is', null)
        .where('expires_at', '>', new Date())
        .where('attempts', '<', UPLOAD_CODE_TRIES)
        .orderBy('sent_at', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (presented && code && timingSafeEqual(code.code_hash, presented)) {
        await trx
          .updateTable('upload_code')
          .set({ used_at: new Date() })
          .where('id', '=', code.id)
          .execute();
        return 'right';
      }
      if (presented) {
        const used = await trx
          .selectFrom('upload_code')
          .select('id')
          .where('request_id', '=', r.id)
          .where('used_at', 'is not', null)
          .where('expires_at', '>', new Date())
          .where('code_hash', '=', presented)
          .executeTakeFirst();
        if (used) return 'code used';
      }
      right = false;
      // The code's own five tries count too.
      if (code) {
        await trx
          .updateTable('upload_code')
          .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
          .where('id', '=', code.id)
          .execute();
      }
    }
    if (right) return 'right';
    const counted = await trx
      .updateTable('upload_request')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', r.id)
      .where('attempts', '<', MAX_ATTEMPTS)
      .returning('attempts')
      .executeTakeFirst();
    if (!counted) return 'gone';
    if (counted.attempts < MAX_ATTEMPTS) return { wrong: MAX_ATTEMPTS - counted.attempts };
    // The tenth, once in the request's life: failed tries are counters,
    // never audit rows; the lock is one row.
    await trx.deleteFrom('upload_session').where('request_id', '=', r.id).execute();
    await trx.deleteFrom('upload_code').where('request_id', '=', r.id).execute();
    await appendAudit(trx, {
      householdId: r.household_id,
      actorLabel: this.actorLabel(r),
      action: 'upload_request.locked',
      objectType: 'upload_request',
      objectId: r.id,
      ip: truncatedIp(meta.ip),
    });
    return 'locked';
  }

  /** What the family's log calls the sender: "upload link (Jane, accountant)". */
  private actorLabel(r: { recipient_label: string | null }): string {
    return r.recipient_label ? `upload link (${r.recipient_label})` : 'upload link';
  }

  /** What is open in this browser's session. Free: nothing is counted. */
  async session(cookie: string | undefined): Promise<DropSession> {
    return this.inSession(cookie, (trx, r, s) => this.sessionView(trx, r, s.id, s.expires_at));
  }

  /**
   * Runs `fn` as the upload link, inside the session a cookie names, after
   * the full check: the session (not ended, not idle for 30 minutes) and
   * its request as it is now. A session that fails is removed.
   */
  private async inSession<T>(
    cookie: string | undefined,
    fn: (
      trx: Db,
      r: RequestRow,
      session: { id: string; expires_at: Date },
      scope: UploadScope,
    ) => Promise<T>,
  ): Promise<T> {
    if (!cookie || cookie.length > 128) throw sessionEnded();
    const cookieHash = hash(cookie);
    const found = (
      await sql<{ household_id: string; request_id: string; session_id: string }>`
        select household_id, request_id, session_id from upload_session_find(${cookieHash})
      `.execute(this.db)
    ).rows[0];
    if (!found) throw sessionEnded();
    const scope: UploadScope = {
      householdId: found.household_id,
      actor: { kind: 'upload', requestId: found.request_id, sessionId: found.session_id },
    };
    const outcome = await withScope(this.db, scope, async (trx) => {
      const session = await trx
        .selectFrom('upload_session')
        .select(['id', 'expires_at', 'last_seen_at'])
        .where('id', '=', found.session_id)
        .where('cookie_hash', '=', cookieHash)
        .executeTakeFirst();
      if (!session) return { ended: 'session' } as const;
      const now = Date.now();
      const end = async (why: 'session' | 'request') => {
        await trx.deleteFrom('upload_session').where('id', '=', session.id).execute();
        return { ended: why } as const;
      };
      if (
        session.expires_at.getTime() <= now ||
        session.last_seen_at.getTime() + DROP_SESSION_IDLE_MS <= now
      ) {
        return end('session');
      }
      let r: RequestRow;
      try {
        r = await this.live(trx, found.request_id);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'link_not_valid') return end('request');
        throw err;
      }
      await trx
        .updateTable('upload_session')
        .set({ last_seen_at: new Date(now) })
        .where('id', '=', session.id)
        .execute();
      return { value: await fn(trx, r, session, scope) } as const;
    });
    if ('ended' in outcome) throw outcome.ended === 'session' ? sessionEnded() : gone();
    return outcome.value;
  }

  /**
   * What the sender is shown inside a session: what they are asked for, and
   * what they have sent from this browser. Never the person or the kind the
   * requester guessed at, nor anybody else's files.
   */
  private async sessionView(
    trx: Db,
    r: RequestRow,
    sessionId: string,
    sessionEnds: Date,
  ): Promise<DropSession> {
    const items = await trx
      .selectFrom('upload_request_item')
      .select(['id', 'label'])
      .where('request_id', '=', r.id)
      .orderBy('position')
      .execute();
    const files = await trx
      .selectFrom('incoming_file')
      .select(['id', 'original_name', 'mime', 'byte_size', 'item_id'])
      .where('session_id', '=', sessionId)
      .where('state', '=', 'received')
      .orderBy('created_at')
      .execute();
    const bytesLeft = Math.max(0, Number(r.max_total_bytes) - Number(r.bytes_used));
    return {
      request_id: r.id,
      ...(await this.names(trx, r)),
      title: r.title,
      message: r.message,
      items,
      accept_types: r.accept_types,
      accepted: uploadRequestTypes(r.accept_types),
      max_files: r.max_files,
      files_left: Math.max(0, r.max_files - r.files_used),
      bytes_left: bytesLeft,
      max_file_bytes: Math.min(this.opts.maxFileBytes, bytesLeft),
      expires_at: r.expires_at.toISOString(),
      session_expires_at: sessionEnds.toISOString(),
      files: files.map(dropFile),
    };
  }

  /** Before any byte is read: whether this session may send a file at all. */
  async mayAdd(cookie: string | undefined): Promise<void> {
    await this.inSession(cookie, async (_trx, r) => {
      if (r.files_used >= r.max_files) throw filesUsedUp(r.max_files);
    });
  }

  /**
   * One file in (POST /drop/files). First, under the household's lock, its
   * room is reserved: what it says it will be (the upload's length), or the
   * most it could be, within the file's own limit and what is left of the
   * request's and the household's caps once every file already in, and
   * every file still arriving, is counted (incoming_room(), 0044). No room,
   * and it is refused before a byte is read. Its row holds the reservation,
   * `uploading`, so a try that dies leaves something the nightly prune
   * finds. Then its bytes: sniffed as they come (a kind the request does not
   * take is stopped at once), cut off at the room reserved, and encrypted
   * under the reviewer's key straight to its object; then, for a Word or
   * Excel file, its package read where it is kept; then the commit, which
   * counts it against the request. Refused anywhere, nothing of it is kept:
   * not the object, not the row.
   */
  async addFile(cookie: string | undefined, upload: DropUpload): Promise<DropFile> {
    const ctx = await this.inSession(cookie, async (trx, r, session, scope) => {
      if (upload.itemId) {
        const item = await trx
          .selectFrom('upload_request_item')
          .select('id')
          .where('id', '=', upload.itemId)
          .where('request_id', '=', r.id)
          .executeTakeFirst();
        if (!item) {
          throw new ApiError(422, 'validation_failed', 'That is not one of the things asked for.');
        }
      }
      // One household's reservations one at a time: what senders at once
      // hold can never together pass a cap.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`incoming:${scope.householdId}`}, 0))`.execute(
        trx,
      );
      const room = (
        await sql<{ household_bytes: string; request_files: number; request_bytes: string }>`
          select household_bytes, request_files, request_bytes from incoming_room(${r.id})
        `.execute(trx)
      ).rows[0];
      const arriving = Number(room?.request_files ?? 0);
      if (r.files_used + arriving >= r.max_files) throw filesUsedUp(r.max_files);
      const limits = {
        file: this.opts.maxFileBytes,
        request:
          Number(r.max_total_bytes) - Number(r.bytes_used) - Number(room?.request_bytes ?? 0),
        household: this.householdMax - Number(room?.household_bytes ?? 0),
      };
      const most = Math.min(limits.file, limits.request, limits.household);
      if (most <= 0) throw tooBigFor(limits, 1, Number(r.max_total_bytes));
      // What it says it will be, when it says: the multipart body is a
      // little more than the file, so the file fits in it.
      const reserved =
        upload.declaredBytes !== null && upload.declaredBytes > 0
          ? Math.min(most, upload.declaredBytes)
          : most;
      const active = await this.vaults.activeAdapter(trx, scope.householdId);
      const scopeKey = await this.keys.unwrap(
        trx,
        r.review_by === 'me'
          ? { householdId: scope.householdId, kind: 'member', memberId: r.requester_member_id }
          : { householdId: scope.householdId, kind: 'adults' },
      );
      const fileKey = newKey();
      const fileId = randomUUID();
      const row = await trx
        .insertInto('incoming_file')
        .values({
          id: fileId,
          household_id: scope.householdId,
          request_id: r.id,
          review_by: r.review_by,
          requester_member_id: r.requester_member_id,
          item_id: upload.itemId,
          session_id: session.id,
          original_name: safeName(upload.filename),
          reserved_bytes: reserved,
          // The object's name says nothing about the file.
          storage_key: `${scope.householdId}/incoming/${r.id}/${randomBytes(16).toString('hex')}.enc`,
          vault_id: active.vaultId,
          // Bound to the file it is for: a wrapped key copied to another row does not open.
          file_key_wrapped: wrapKey(fileKey, scopeKey.key, `incoming:${fileId}`),
          wrapped_by_scope: scopeKey.id,
          scope: r.review_by === 'me' ? 'member' : 'adults',
        })
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      return {
        scope,
        fileId: row.id,
        key: row.storage_key,
        adapter: active.adapter,
        fileKey,
        accept: r.accept_types,
        limits,
        reserved,
        maxTotal: Number(r.max_total_bytes),
      };
    });

    const discard = async () => {
      await ctx.adapter.delete(ctx.key).catch(() => undefined);
      await withScope(this.db, ctx.scope, (trx) =>
        trx.deleteFrom('incoming_file').where('id', '=', ctx.fileId).execute(),
      ).catch(() => undefined);
    };

    // Cut off at the room reserved, as the bytes come: a sender that says
    // one length and sends another is stopped there too.
    let bytes = 0;
    let head = Buffer.alloc(0);
    let sniffed = false;
    const plainHash = createHash('sha256');
    const counted = new PassThrough();
    const sniff = () => {
      if (sniffed) return;
      sniffed = true;
      // A kind the request does not take is stopped now, not once it has
      // all arrived.
      this.quickKind(head, ctx.accept).catch((err: unknown) => counted.destroy(err as Error));
    };
    counted.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      plainHash.update(chunk);
      if (head.length < SNIFF_BYTES) {
        head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
        if (head.length >= SNIFF_BYTES) sniff();
      }
      if (bytes > ctx.reserved) {
        counted.destroy(tooBigFor(ctx.limits, bytes, ctx.maxTotal, ctx.reserved));
      }
    });
    const enc = new EncryptStream(ctx.fileKey);
    const storing = ctx.adapter.put(ctx.key, enc);
    const flowing = pipeline(upload.stream, counted, enc);
    let put: { bytes: number; sha256: string };
    try {
      [put] = await Promise.all([storing, flowing]);
      if (upload.truncated()) throw tooBigFor(ctx.limits, bytes + 1, ctx.maxTotal, ctx.reserved);
      await upload.finished();
    } catch (err) {
      enc.destroy();
      await Promise.allSettled([storing, flowing]);
      await discard();
      if (err instanceof ApiError) throw err;
      throw storageUnreachable((err as Error).message);
    }

    // What it is, from its bytes: never its name or what it was said to be.
    let mime: string;
    try {
      mime = await this.kindOf(head, bytes, ctx);
    } catch (err) {
      await discard();
      throw err;
    }

    try {
      const view = await this.inSession(cookie, async (trx, r) => {
        // Within the request's files and bytes, however many arrive at once:
        // one statement counts it, or finds there is no room. (Its room was
        // reserved; this is the floor under that.)
        const room = await trx
          .updateTable('upload_request')
          .set((eb) => ({
            files_used: eb('files_used', '+', 1),
            bytes_used: eb('bytes_used', '+', bytes),
          }))
          .where('id', '=', r.id)
          .where((eb) => eb('files_used', '<', eb.ref('max_files')))
          .where(sql<boolean>`bytes_used + ${bytes} <= max_total_bytes`)
          .returning('id')
          .executeTakeFirst();
        if (!room) {
          throw r.files_used >= r.max_files
            ? filesUsedUp(r.max_files)
            : tooBigFor({ ...ctx.limits, request: 0 }, bytes, ctx.maxTotal);
        }
        const done = await trx
          .updateTable('incoming_file')
          .set({
            state: 'received',
            mime,
            byte_size: bytes,
            sha256: plainHash.digest(),
            cipher_bytes: put.bytes,
            cipher_sha256: Buffer.from(put.sha256, 'hex'),
            received_at: new Date(),
          })
          .where('id', '=', ctx.fileId)
          .where('state', '=', 'uploading')
          .returning(['id', 'original_name', 'mime', 'byte_size', 'item_id'])
          .executeTakeFirst();
        if (!done) throw sessionEnded();
        return dropFile(done);
      });
      return view;
    } catch (err) {
      await discard();
      throw err;
    }
  }

  /**
   * From the first bytes alone: a kind the request cannot take at all. A
   * zip goes on (its package is read once it has all arrived) only for a
   * request that takes Word and Excel files.
   */
  private async quickKind(head: Buffer, accept: 'standard' | 'office'): Promise<void> {
    if (isZip(head)) {
      if (accept !== 'office') throw wrongType(accept);
      return;
    }
    await this.photoOrPdf(head, accept);
  }

  private async photoOrPdf(head: Buffer, accept: 'standard' | 'office'): Promise<string> {
    const { fileTypeFromBuffer } = await import('file-type');
    const found = await fileTypeFromBuffer(head);
    const mime = found?.mime === 'image/heif' ? 'image/heic' : found?.mime;
    if (!mime || !uploadRequestTypes('standard').includes(mime)) throw wrongType(accept);
    return mime;
  }

  /**
   * What a file is, from its first bytes (and a zip from its package): one
   * of the kinds the request takes, or refused. PDFs and photos by
   * file-type's reading; a zip is taken only as the Word or Excel file its
   * own package says it is, with nothing that runs, and only by a request
   * that takes them. The package is read a chunk at a time, each decrypted
   * once (office.ts).
   */
  private async kindOf(
    head: Buffer,
    size: number,
    ctx: { adapter: StorageAdapter; key: string; fileKey: Buffer; accept: 'standard' | 'office' },
  ): Promise<string> {
    if (isZip(head)) {
      if (ctx.accept !== 'office') throw wrongType(ctx.accept);
      const verdict = await inspectOffice({
        size,
        chunkSize: CHUNK_SIZE,
        read: (i) =>
          decryptRange(
            ctx.fileKey,
            size,
            { start: i * CHUNK_SIZE, end: Math.min(size, (i + 1) * CHUNK_SIZE) - 1 },
            async (s, e) => readAll(await ctx.adapter.get(ctx.key, { start: s, end: e })),
          ),
      });
      if ('refused' in verdict) {
        throw verdict.refused === 'macros' ? macros() : wrongType(ctx.accept);
      }
      return verdict.mime;
    }
    return this.photoOrPdf(head, ctx.accept);
  }

  /**
   * Takes back a file this session sent, before Finish (DELETE
   * /drop/files/{id}). Only its own: another session's file, or one already
   * sent, is not there for it.
   */
  async removeFile(cookie: string | undefined, fileId: string): Promise<void> {
    const removed = await this.inSession(cookie, async (trx, r, session, scope) => {
      const file = await trx
        .selectFrom('incoming_file')
        .select(['id', 'state', 'byte_size', 'storage_key', 'vault_id'])
        .where('id', '=', fileId)
        .where('session_id', '=', session.id)
        .where('submitted_at', 'is', null)
        .where('state', 'in', ['received', 'uploading'])
        .executeTakeFirst();
      if (!file) throw new ApiError(404, 'not_found', 'That file is not here.');
      await trx.deleteFrom('incoming_file').where('id', '=', file.id).execute();
      if (file.state === 'received') {
        await trx
          .updateTable('upload_request')
          .set((eb) => ({
            files_used: eb('files_used', '-', 1),
            bytes_used: eb('bytes_used', '-', Number(file.byte_size ?? 0)),
          }))
          .where('id', '=', r.id)
          .execute();
      }
      const adapter = await this.vaults.adapterById(trx, file.vault_id);
      return { adapter, key: file.storage_key, scope };
    });
    await removed.adapter.delete(removed.key).catch(() => undefined);
  }

  /**
   * Finish: this session's files are sent, with the sender's note. With
   * "close after the first sending", the request closes: its link opens
   * nothing more, its sessions and codes end and its address is cleared.
   */
  async finish(
    cookie: string | undefined,
    input: z.infer<typeof dropFinishBody>,
    meta: RequestMeta,
  ): Promise<DropFinished> {
    return this.inSession(cookie, async (trx, r, session, scope) => {
      const note = input.note?.replace(/\r\n?/g, '\n').trim() || null;
      const sent = await trx
        .updateTable('incoming_file')
        .set({ submitted_at: new Date(), sender_note: note })
        .where('session_id', '=', session.id)
        .where('state', '=', 'received')
        .where('submitted_at', 'is', null)
        .returning('id')
        .execute();
      if (sent.length === 0) {
        throw new ApiError(422, 'nothing_to_send', 'Add a file first, then press Finish.');
      }
      let closed = false;
      if (r.close_after_submit) {
        await trx
          .updateTable('upload_request')
          .set({ closed_at: new Date(), closed_reason: 'submitted', recipient_email: null })
          .where('id', '=', r.id)
          .where('closed_at', 'is', null)
          .execute();
        await trx.deleteFrom('upload_code').where('request_id', '=', r.id).execute();
        await trx.deleteFrom('upload_session').where('request_id', '=', r.id).execute();
        closed = true;
      }
      // How many, never what they are called.
      await appendAudit(trx, {
        householdId: scope.householdId,
        actorLabel: this.actorLabel(r),
        action: 'upload_request.submitted',
        objectType: 'upload_request',
        objectId: r.id,
        detail: { files: sent.length, closed },
        ip: truncatedIp(meta.ip),
      });
      return { files: sent.length, closed };
    });
  }
}

function dropFile(f: {
  id: string;
  original_name: string;
  mime: string | null;
  byte_size: string | number | null;
  item_id: string | null;
}): DropFile {
  return {
    id: f.id,
    name: f.original_name,
    content_type: f.mime ?? 'application/octet-stream',
    byte_size: Number(f.byte_size ?? 0),
    item_id: f.item_id,
  };
}

const filesUsedUp = (max: number) =>
  new ApiError(
    409,
    'files_used_up',
    `This request takes ${max} ${max === 1 ? 'file' : 'files'}, and that many have been sent.`,
  );

/** A zip's first bytes: a local file header. */
const isZip = (head: Buffer) => head.length >= 4 && head.readUInt32LE(0) === 0x04034b50;

/** The cap a file of `bytes` passed, in words: the household's, the request's, or its own. */
function tooBigFor(
  limits: { file: number; request: number; household: number },
  bytes: number,
  maxTotal: number,
  reserved?: number,
): ApiError {
  if (bytes > limits.household) {
    return tooLarge('The vault cannot take any more files just now. Ask whoever sent the link.');
  }
  if (bytes > limits.request) {
    return tooLarge(
      `That file would take this request past the ${megabytes(maxTotal)} it can take in all.`,
    );
  }
  if (bytes > limits.file || reserved === undefined) {
    return tooLarge(`That file is too big: one file can be ${megabytes(limits.file)} at most.`);
  }
  return tooLarge('That file is longer than its upload said it would be.');
}

function megabytes(n: number): string {
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${Math.floor(mb)} MB` : `${Math.max(1, Math.floor(n / 1024))} KB`;
}

/**
 * Requests whose requester can no longer ask — made a teen or a viewer,
 * their sign-in taken away — closed, with their sessions and codes, in the
 * transaction that made the change (A39), and each written down. The
 * database finds them (upload_requests_close_lost(), 0044): whoever makes
 * the change may not see them.
 */
export async function closeLostRequests(
  trx: Db,
  householdId: string,
  actorAccountId: string,
  ip: string | null | undefined,
): Promise<number> {
  const r = await sql<{ id: string }>`select id from upload_requests_close_lost() as id`.execute(
    trx,
  );
  for (const { id } of r.rows) {
    await appendAudit(trx, {
      householdId,
      actorAccountId,
      action: 'upload_request.closed',
      objectType: 'upload_request',
      objectId: id,
      detail: { reason: 'requester_lost_right' },
      ip,
    });
  }
  return r.rows.length;
}
