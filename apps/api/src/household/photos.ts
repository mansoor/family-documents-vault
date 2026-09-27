import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  EncryptStream,
  memberPhotoBinding,
  memberPhotoSourceBinding,
  newKey,
  openBytes,
  wrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db, type Role } from '@fdv/db';
import {
  canChangePhoto,
  canRemovePhoto,
  PHOTO_MAX_BYTES,
  PHOTO_REFUSAL,
  type PhotoCrop,
} from '@fdv/shared';
import { memberPhotoUploadKey } from '@fdv/storage';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { allows, requireCapability } from '../authz.js';
import type { Enqueue } from '../documents/service.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';

/**
 * A person's photo (5.17c).
 *
 * The API never decodes an image: its image has no image tools, and every
 * picture the vault draws is drawn in the worker, with the coder named and
 * its limits set, away from the process the internet talks to. So the API
 * takes the upload, sniffs what it is from its first bytes, and seals it as
 * it arrives into a temporary object in the vault
 * (`<household>/members/<person>/incoming/<photo>.enc`), under a fresh file
 * key wrapped by the household key. A row says it is on its way, and
 * `member.photo` is queued; the worker makes the square, seals it into the
 * row, and deletes the upload. Nothing of the file — its name, its size, its
 * EXIF — is kept, or logged.
 *
 * Who sees a photo is who sees a birthday (A65): owners, adults and teens
 * everyone's, a viewer only their own. Who changes one is A66
 * (`canChangePhoto`); anybody may take a photo of themselves away. The
 * database holds both (0040): member_photo_actor, and member_photo_person.
 */

/** The worker's queue for making photos: its JOBS.memberPhoto. */
export const PHOTO_JOB = 'member.photo';

export interface PhotoJob {
  household_id: string;
  member_id: string;
  photo_id: string;
  [key: string]: unknown;
}

/** What a photo can be made from, as its first bytes say: never TIFF, never a document. */
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/** The file, as the route has read it so far. */
export interface PhotoUpload {
  crop: PhotoCrop | null;
  stream: NodeJS.ReadableStream;
  /** The parser cut the file off at the limit. */
  truncated: () => boolean;
  /** Nothing may follow the file: asked once it has been read. */
  finished: () => Promise<void>;
}

/** What a person's row says of their photo, to one reader. */
export interface PhotoFields {
  photo: { id: string } | null;
  photo_status: 'processing' | 'failed' | null;
  can_change_photo: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Anything the photo route answers when there is nothing it may give. */
export const noPhoto = () => new ApiError(404, 'no_photo', 'There is no photo here.');

/** Said to whoever sent the parts in another order, or more of them. */
export const photoOrder = () =>
  new ApiError(422, 'validation_failed', 'Send the crop first, then the photo.');

const refused = () => new ApiError(403, 'forbidden', PHOTO_REFUSAL);
const notAPhoto = (detected: string) =>
  new ApiError(415, 'unsupported_type', 'Choose a photo: JPEG, PNG, WebP or HEIC.', {
    // What the bytes are, for the log: never the file's name.
    detail: `detected ${detected}`,
  });
const tooLarge = () =>
  new ApiError(413, 'too_large', 'That photo is too big. Choose one of 20 MB or less.');
const storageUnreachable = (detail: string) =>
  new ApiError(
    503,
    'storage_unreachable',
    "We can't reach where your files are kept. Your photo was not saved; try again.",
    { detail, retriable: true, retryAfter: 30 },
  );

/** How far over the edge a crop's rounding may take it. */
const CROP_SLACK = 1e-3;

/**
 * The crop, as sent in the `crop` field: fractions of the upright picture,
 * each from 0 to 1, inside it, at least 0.05 a side. Empty is the middle.
 */
export function parseCrop(raw: unknown): PhotoCrop | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw badCrop();
    }
  }
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw badCrop();
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'h,w,x,y') throw badCrop();
  const [x, y, w, h] = [v.x, v.y, v.w, v.h];
  const fraction = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!fraction(x) || !fraction(y) || !fraction(w) || !fraction(h)) throw badCrop();
  // A hair over 1, from fractions each rounded, is the edge: taken as that,
  // not refused (the 5.17c review: a crop at the picture's edge could be
  // sent a ten-thousandth over it).
  if (w < 0.05 || h < 0.05 || x + w > 1 + CROP_SLACK || y + h > 1 + CROP_SLACK) throw badCrop();
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h };
}

const badCrop = () =>
  new ApiError(
    422,
    'validation_failed',
    'The part of the photo to show must be inside it, and not too small.',
    { detail: 'crop' },
  );

/**
 * What each person's row says of their photo to this reader, read in the
 * caller's own transaction (so as the database gives it to them): the ready
 * photo to the family, and to a viewer their own; a new one on its way, or
 * refused, only to whoever may change it; and whether they may.
 */
export async function photoFields(
  trx: Db,
  p: Principal,
  people: ReadonlyArray<{ id: string; role: Role | null }>,
): Promise<Map<string, PhotoFields>> {
  const rows = await trx.selectFrom('member_photo').select(['id', 'member_id', 'state']).execute();
  const viewer = { role: p.role, memberId: p.memberId };
  const family = allows(p, 'family.details');
  const out = new Map<string, PhotoFields>();
  for (const person of people) {
    const theirs = rows.filter((r) => r.member_id === person.id);
    const ready = theirs.find((r) => r.state === 'ready');
    const unfinished = theirs.find((r) => r.state !== 'ready');
    const may = canChangePhoto(viewer, person);
    out.set(person.id, {
      photo: ready && (family || person.id === p.memberId) ? { id: ready.id } : null,
      photo_status: may && unfinished ? (unfinished.state as PhotoFields['photo_status']) : null,
      can_change_photo: may,
    });
  }
  return out;
}

export class PhotoService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    private readonly enqueue: Enqueue,
    private readonly maxUploadBytes: number,
  ) {}

  /** The most a photo's upload may be: 20 MiB, or less if the vault takes less. */
  get limit(): number {
    return Math.min(PHOTO_MAX_BYTES, this.maxUploadBytes);
  }

  /**
   * Whether the caller may give this person a photo: a person they cannot
   * see is not there (404); then `member.photo`, then whose (403).
   */
  async mayChange(p: Principal, memberId: string): Promise<void> {
    await withPrincipal(this.db, p, (trx) => this.changeable(trx, p, memberId));
  }

  /**
   * PUT /members/{id}/photo: the upload sealed as it arrives, one row on its
   * way for the person (replacing whatever was unfinished), and the worker
   * asked to make it. Refused on its type (415) or its size (413), nothing
   * is kept. Returns the person's id as the database spells it: the one
   * everything here is filed under and bound to, however the address
   * spelled it (the 5.17c review).
   */
  async accept(
    p: Principal,
    requested: string,
    upload: PhotoUpload,
    // Nothing is audited until the photo is made (the worker writes it).
    _meta: RequestMeta,
  ): Promise<string> {
    const photoId = randomUUID();
    const hh = p.householdId;
    const ctx = await withPrincipal(this.db, p, async (trx) => {
      const person = await this.changeable(trx, p, requested);
      const active = await this.vaults.activeAdapter(trx, hh);
      const scope = await this.keys.unwrap(trx, { householdId: hh, kind: 'household' });
      return { memberId: person.id, active, scopeKey: scope.key };
    });
    const memberId = ctx.memberId;
    const key = memberPhotoUploadKey({ householdId: hh, memberId, photoId });
    const fileKey = newKey();
    const { adapter, vaultId } = ctx.active;

    // A second file or field after the photo, found by the parser while the
    // person was being checked: it has stopped the photo already, before a
    // byte was read, and a stream stopped so would never end. (Nothing is
    // awaited from here until the photo is being read.)
    if ((upload.stream as { destroyed?: boolean }).destroyed) {
      const refusal = await upload.finished().then(
        () => photoOrder(),
        (e: unknown) => orderRefusal(e),
      );
      throw refusal instanceof ApiError ? refusal : photoOrder();
    }

    const sniffer = sniffPhoto();
    let bytes = 0;
    const counted = new PassThrough();
    counted.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > this.limit) counted.destroy(tooLarge());
    });
    const enc = new EncryptStream(fileKey);
    const storing = adapter.put(key, enc);
    const flowing = pipeline(upload.stream, sniffer.stream, counted, enc);
    try {
      await Promise.all([storing, flowing, sniffer.detected]);
      // Cut off at the limit on the way in: what arrived is not the photo.
      if (upload.truncated()) throw tooLarge();
      await upload.finished();
    } catch (err) {
      // Stop the bytes, let the write finish failing, and take away what
      // was written: a refused photo is not kept, not for a moment longer.
      enc.destroy();
      await Promise.allSettled([storing, flowing]);
      await adapter.delete(key).catch(() => undefined);
      if (err instanceof ApiError) throw err;
      // The parser cuts the photo short when a second file or field
      // follows it: that is the order's refusal, not the storage's.
      const refusal = orderRefusal(err);
      if (refusal instanceof ApiError) throw refusal;
      const after = await upload.finished().then(
        () => null,
        (e: unknown) => orderRefusal(e),
      );
      if (after instanceof ApiError) throw after;
      throw storageUnreachable((err as Error).message);
    }

    const leftovers: Array<{ key: string; vaultId: string }> = [];
    try {
      await withPrincipal(this.db, p, async (trx) => {
        await lockPerson(trx, hh, memberId);
        // Asked again under the lock: a role can change while a photo uploads.
        await this.changeable(trx, p, memberId);
        const gone = await trx
          .deleteFrom('member_photo')
          .where('member_id', '=', memberId)
          .where('state', '<>', 'ready')
          .returning(['source_key', 'source_vault_id'])
          .execute();
        for (const g of gone) {
          if (g.source_key && g.source_vault_id) {
            leftovers.push({ key: g.source_key, vaultId: g.source_vault_id });
          }
        }
        await trx
          .insertInto('member_photo')
          .values({
            id: photoId,
            household_id: hh,
            member_id: memberId,
            state: 'processing',
            crop: upload.crop ? JSON.stringify(upload.crop) : null,
            source_key: key,
            source_vault_id: vaultId,
            source_key_wrapped: wrapKey(
              fileKey,
              ctx.scopeKey,
              memberPhotoSourceBinding(hh, memberId, photoId),
            ),
            created_by: p.accountId,
          })
          .execute();
      });
    } catch (err) {
      await adapter.delete(key).catch(() => undefined);
      throw err;
    }
    // The newest choice wins: an earlier one still on its way goes now.
    for (const l of leftovers) await this.dropObject(p, l).catch(() => undefined);

    const job: PhotoJob = { household_id: hh, member_id: memberId, photo_id: photoId };
    try {
      await this.enqueue(PHOTO_JOB, job);
    } catch (err) {
      // Nobody will make it: nothing is left waiting for a worker.
      await withPrincipal(this.db, p, (trx) =>
        trx.deleteFrom('member_photo').where('id', '=', photoId).execute(),
      ).catch(() => undefined);
      await adapter.delete(key).catch(() => undefined);
      throw new ApiError(
        503,
        'queue_unreachable',
        "We couldn't get the photo ready just now. Try again in a moment.",
        { detail: (err as Error).message, retriable: true, retryAfter: 30 },
      );
    }
    return memberId;
  }

  /**
   * DELETE /members/{id}/photo: the person's photo goes, with any on its way
   * and its upload. By whoever may change it, or the person themselves;
   * nothing there is no refusal.
   */
  async remove(p: Principal, requested: string, meta: RequestMeta): Promise<void> {
    const uploads: Array<{ key: string; vaultId: string }> = [];
    await withPrincipal(this.db, p, async (trx) => {
      const person = await this.person(trx, requested);
      if (!canRemovePhoto({ role: p.role, memberId: p.memberId }, person)) throw refused();
      // Their own id, as the database spells it: the lock and the log's line
      // are theirs however the address spelled it.
      const memberId = person.id;
      await lockPerson(trx, p.householdId, memberId);
      const gone = await trx
        .deleteFrom('member_photo')
        .where('member_id', '=', memberId)
        .returning(['state', 'source_key', 'source_vault_id'])
        .execute();
      for (const g of gone) {
        if (g.source_key && g.source_vault_id) {
          uploads.push({ key: g.source_key, vaultId: g.source_vault_id });
        }
      }
      if (gone.some((g) => g.state === 'ready')) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'member.photo_removed',
          objectType: 'member',
          objectId: memberId,
          detail: {},
          ip: meta.ip,
        });
      }
    });
    for (const u of uploads) await this.dropObject(p, u).catch(() => undefined);
  }

  /**
   * GET /members/{id}/photo/{photoId}: the ready photo, opened, for the
   * family or the person themselves. Anything else — not allowed, no photo,
   * an old id — is null; a seal that does not open is 'unreadable', which
   * the route logs and answers the same. The seal is opened by the row's
   * own ids, so an address in capitals opens the same photo, and only a
   * seal moved or altered is unreadable (the 5.17c review).
   */
  async photo(
    p: Principal,
    memberId: string,
    photoId: string,
  ): Promise<Buffer | 'unreadable' | null> {
    if (!UUID.test(memberId) || !UUID.test(photoId)) return null;
    if (!allows(p, 'family.details') && memberId.toLowerCase() !== p.memberId) return null;
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('member_photo')
        .select(['id', 'member_id', 'sealed'])
        .where('id', '=', photoId)
        .where('member_id', '=', memberId)
        .where('state', '=', 'ready')
        .executeTakeFirst();
      if (!row?.sealed) return null;
      const scope = await this.keys.unwrap(trx, { householdId: p.householdId, kind: 'household' });
      try {
        return openBytes(
          scope.key,
          row.sealed,
          memberPhotoBinding(p.householdId, row.member_id, row.id),
        );
      } catch {
        return 'unreadable';
      }
    });
  }

  /** The person, as the caller may see them; 404 otherwise. */
  private async person(trx: Db, memberId: string): Promise<{ id: string; role: Role | null }> {
    const row = UUID.test(memberId)
      ? await trx
          .selectFrom('member')
          .leftJoin('account_household', (j) =>
            j
              .onRef('account_household.member_id', '=', 'member.id')
              .onRef('account_household.household_id', '=', 'member.household_id'),
          )
          .select(['member.id', 'account_household.role'])
          .where('member.id', '=', memberId)
          .executeTakeFirst()
      : undefined;
    if (!row) throw new ApiError(404, 'not_found', 'That person is not in the family.');
    return { id: row.id, role: row.role };
  }

  /** 404 for a person not given, then `member.photo`, then whose: in that order. */
  private async changeable(
    trx: Db,
    p: Principal,
    memberId: string,
  ): Promise<{ id: string; role: Role | null }> {
    const person = await this.person(trx, memberId);
    requireCapability(p, 'member.photo');
    if (!canChangePhoto({ role: p.role, memberId: p.memberId }, person)) throw refused();
    return person;
  }

  private async dropObject(p: Principal, at: { key: string; vaultId: string }) {
    const adapter = await withPrincipal(this.db, p, (trx) =>
      this.vaults.adapterById(trx, at.vaultId),
    );
    await adapter.delete(at.key);
  }
}

/** One change to a person's photo at a time. */
const lockPerson = (trx: Db, householdId: string, memberId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`member-photo:${householdId}:${memberId}`}, 0))`.execute(
    trx,
  );

/**
 * The parser's refusal of a part past the ones a photo takes (a second
 * file, a second field) is the order's refusal; anything else is itself.
 */
export function orderRefusal(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT'
    ? photoOrder()
    : err;
}

/**
 * A pass-through that reads the first bytes as they flow and says what they
 * are: a photo the worker can make a square of, or a refusal naming what
 * the bytes were (never the file). It never stops the flow itself.
 */
function sniffPhoto() {
  const SNIFF_BYTES = 4100;
  let head: Buffer = Buffer.alloc(0);
  let settled = false;
  let resolve!: (mime: string) => void;
  let reject!: (e: Error) => void;
  const detected = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  detected.catch(() => undefined); // observed again by the caller

  const settle = async () => {
    if (settled) return;
    settled = true;
    const { fileTypeFromBuffer } = await import('file-type');
    const found = await fileTypeFromBuffer(head);
    if (!found || !PHOTO_MIMES.has(found.mime)) {
      reject(notAPhoto(found?.mime ?? 'unknown'));
      return;
    }
    resolve(found.mime);
  };

  const stream = new PassThrough({
    transform(chunk: Buffer, _enc, cb) {
      if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
      if (head.length >= SNIFF_BYTES) void settle();
      cb(null, chunk);
    },
    flush(cb) {
      void settle().then(() => cb(), cb);
    },
  });
  return { stream, detected };
}
