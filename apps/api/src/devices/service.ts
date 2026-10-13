import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { appendAudit, withPrincipal, withSystem, type Db } from '@fdv/db';
import {
  BATCH_MAX_FILES,
  can,
  DEVICE_REFUSALS,
  lockInEffect,
  normalisePairingCode,
  PAIRING_ALPHABET,
  PAIRING_ATTEMPTS,
  PAIRING_CODE_LENGTH,
  PAIRING_MINUTES,
  refusalFor,
  seesAdults,
  showPairingCode,
  suspensionInEffect,
  UPLOAD_KINDS,
  type DeviceMe,
  type DevicePairInput,
  type DevicePaired,
  type DevicePairingCode,
  type DevicePausedReason,
  type DeviceUploaded,
  type PairedDevice,
  type Role,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { BatchService, BatchUpload } from '../uploads/batches.js';

/**
 * A computer that sends scans (0.8.0, D1): pairing, and an upload-only key.
 *
 * Somebody who may add documents — an owner, an adult, a teen; never a
 * viewer or a guest — asks for a code (after the step-up, which the route
 * asks for): eight letters and digits that read as nothing else, shown
 * once, good for 10 minutes and five wrong tries, one a person. The
 * uploader app on their computer trades it, with a name and a platform,
 * for a key of its own: 32 random bytes, answered once. The vault keeps
 * neither. A code is kept as an HMAC under a key of the server's own
 * (`DEVICE_KEY_PURPOSE`): it is short, so a dump must not be searchable
 * for it, nor a guess tried against it without the server. A key is kept
 * as its SHA-256 (`deviceKeyHash`): 256 random bits need no secret beside
 * them to be beyond guessing, and so a key outlives a rotation of the
 * master key, as a computer should.
 *
 * A code is found by its first half and proved by the whole: a wrong try is
 * counted on the code its first half names, and five end it. A first half
 * that names no code is answered as a wrong one, and counted by nothing but
 * the route's own limit for an address.
 *
 * The key is sent as `Authorization: Device <id>.<key>` and is taken by two
 * routes alone (devices/routes.ts): it puts a file into its person's own
 * uploads, a batch a day, as they would (BatchService.addItem); and it says
 * what it is. Its files are its person's, under their own member key, seen
 * by nobody else until they accept them — not by an owner.
 *
 * Revoked, never removed: by its person, by an owner, and by the database
 * in the same transaction as its person's sign-in goes or their role can
 * no longer add (0070); the API writes the activity log's line for each.
 */

/** The purpose the HMAC key for pairing codes is derived for (`deriveKey`). */
export const DEVICE_KEY_PURPOSE = 'upload-device-codes';

/** What the vault keeps of a computer's key: its SHA-256, bound to the computer it is for. */
export function deviceKeyHash(deviceId: string, key: string): Buffer {
  return createHash('sha256').update(`fdv-device-key:${deviceId}.${key}`, 'utf8').digest();
}

const KEY_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

export interface DeviceOptions {
  /** The HMAC key for codes, derived from the master key for DEVICE_KEY_PURPOSE. */
  hmacKey: Buffer;
  /** The vault's address (FDV_BASE_URL), as the app is to be told it. */
  baseUrl: string;
  /** Where the uploader app is downloaded from (FDV_DESKTOP_DOWNLOAD_URL). */
  downloadUrl: string | null;
  /** FDV_MAX_UPLOAD_BYTES. */
  maxUploadBytes: number;
  /** The person told a computer was added (the alert's mail path). */
  alert: (a: AlertRequest) => Promise<void>;
}

/** Whoever a key is, once it has been checked: its computer and its person. */
export interface DeviceCaller {
  deviceId: string;
  householdId: string;
  accountId: string;
  memberId: string;
  role: Role;
  name: string;
  memberName: string;
  paused: DevicePausedReason | null;
}

const wrongCode = () =>
  new ApiError(
    401,
    'pairing_code_invalid',
    'That code is not right, or it has run out. Make a new one in Settings → Your computers.',
  );
const unknownKey = () =>
  new ApiError(
    401,
    'unauthenticated',
    'This computer’s key is not one this vault knows. Pair it again in Settings → Your computers.',
  );
const revoked = () => new ApiError(401, 'device_revoked', DEVICE_REFUSALS.device_revoked);
const cannotPair = () => new ApiError(403, 'forbidden', refusalFor('document.add'));
const notHere = () => new ApiError(404, 'not_found', 'That computer is not here.');

/** A refusal for a computer whose person may not add documents just now. */
function pausedRefusal(reason: DevicePausedReason): ApiError {
  switch (reason) {
    case 'cannot_add':
      return new ApiError(403, 'cannot_add', DEVICE_REFUSALS.cannot_add);
    case 'locked':
      return new ApiError(403, 'member_locked', DEVICE_REFUSALS.member_locked);
    case 'paused_after_restore':
      return new ApiError(403, 'member_paused', DEVICE_REFUSALS.member_paused);
  }
}

/** Why somebody's sign-in stops their computer for now, if it does. */
function pausedFor(m: {
  role: Role;
  suspend_reason: string | null;
  suspended_at: Date | null;
  suspended_until: Date | null;
}): DevicePausedReason | null {
  if (!can(m.role, 'document.add')) return 'cannot_add';
  if (lockInEffect(m)) return 'locked';
  if (suspensionInEffect(m)) return 'paused_after_restore';
  return null;
}

export class DeviceService {
  constructor(
    private readonly db: Db,
    private readonly batches: BatchService,
    private readonly opts: DeviceOptions,
  ) {}

  private hmac(what: 'handle' | 'code', value: string): Buffer {
    return createHmac('sha256', this.opts.hmacKey).update(`${what}:${value}`, 'utf8').digest();
  }

  /** Only whoever may add documents pairs a computer: a viewer or a guest is refused. */
  private mayAdd(p: Principal): void {
    if (!can(p.role, 'document.add')) throw cannotPair();
  }

  // ---------------------------------------------------------------- pairing

  /**
   * POST /device-pairings: a new code for the caller, replacing any they
   * had. The route has asked for the step-up already.
   */
  async createPairing(p: Principal): Promise<DevicePairingCode> {
    this.mayAdd(p);
    const made = await withPrincipal(this.db, p, async (trx) => {
      const me = await trx
        .selectFrom('account_household')
        .select(['role', 'suspended_at', 'suspended_until', 'suspend_reason'])
        .where('account_id', '=', p.accountId)
        .where('household_id', '=', p.householdId)
        .forShare()
        .executeTakeFirst();
      if (!me || pausedFor(me) !== null) throw cannotPair();
      // A clash of first halves with somebody else's live code, or a code of
      // their own made at the same moment: tried again, with a new code.
      for (let i = 0; i < 8; i++) {
        await trx.deleteFrom('device_pairing').where('member_id', '=', p.memberId).execute();
        const code = Array.from(
          { length: PAIRING_CODE_LENGTH },
          () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)],
        ).join('');
        const row = await trx
          .insertInto('device_pairing')
          .values({
            household_id: p.householdId,
            account_id: p.accountId,
            member_id: p.memberId,
            handle_hash: this.hmac('handle', code.slice(0, PAIRING_CODE_LENGTH / 2)),
            code_hash: this.hmac('code', code),
            // On the database's clock, as its rule reads it.
            expires_at: sql<Date>`now() + make_interval(mins => ${PAIRING_MINUTES})`,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('expires_at')
          .executeTakeFirst();
        if (row) return { code, expiresAt: row.expires_at };
      }
      throw new ApiError(503, 'busy', 'The vault was busy just then. Try again.', {
        retriable: true,
        retryAfter: 1,
      });
    });
    return {
      code: showPairingCode(made.code),
      expires_at: made.expiresAt.toISOString(),
      vault_address: this.opts.baseUrl.replace(/\/+$/, ''),
      download_url: this.opts.downloadUrl,
    };
  }

  /**
   * POST /devices/pair: a code traded for a key. Unauthenticated; the route
   * limits each address. A wrong code — run out, used, ended, or never one
   * — is the one answer, `401 pairing_code_invalid`, and a wrong try at a
   * live code is counted on it before it is answered.
   */
  async pair(input: DevicePairInput, meta: RequestMeta): Promise<DevicePaired> {
    const code = normalisePairingCode(input.code);
    if (!code) throw wrongCode();
    const handle = this.hmac('handle', code.slice(0, PAIRING_CODE_LENGTH / 2));
    const proof = this.hmac('code', code);
    const found = await sql<{ household_id: string; pairing_id: string }>`
      select household_id, pairing_id from device_pairing_find(${handle})`.execute(this.db);
    const at = found.rows[0];
    if (!at) throw wrongCode();

    type Outcome =
      | { kind: 'wrong' }
      | { kind: 'refused'; error: ApiError }
      | { kind: 'paired'; answer: DevicePaired; accountId: string; name: string };
    const outcome: Outcome = await withSystem(this.db, at.household_id, async (trx) => {
      const row = await trx
        .selectFrom('device_pairing')
        .selectAll()
        .where('id', '=', at.pairing_id)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.expires_at.getTime() <= Date.now() || row.attempts >= PAIRING_ATTEMPTS) {
        return { kind: 'wrong' };
      }
      if (!timingSafeEqual(row.code_hash, proof)) {
        await trx
          .updateTable('device_pairing')
          .set({ attempts: sql<number>`attempts + 1` })
          .where('id', '=', row.id)
          .execute();
        return { kind: 'wrong' };
      }
      // Its person as they are now, held until the key is made: a role
      // changed or a sign-in taken away waits for it, and it for them.
      const person = await trx
        .selectFrom('account_household as a')
        .innerJoin('member as m', (j) =>
          j.onRef('m.id', '=', 'a.member_id').onRef('m.household_id', '=', 'a.household_id'),
        )
        .select([
          'a.role',
          'a.suspended_at',
          'a.suspended_until',
          'a.suspend_reason',
          'a.member_id',
          'm.display_name',
        ])
        .where('a.account_id', '=', row.account_id)
        .where('a.member_id', '=', row.member_id)
        .forShare('a')
        .executeTakeFirst();
      // Spent, whatever comes of it: a code is used once.
      await trx.deleteFrom('device_pairing').where('id', '=', row.id).execute();
      const paused = person ? pausedFor(person) : 'cannot_add';
      if (!person || paused !== null) {
        return { kind: 'refused', error: pausedRefusal(paused ?? 'cannot_add') };
      }
      const household = await trx.selectFrom('household').select('name').executeTakeFirstOrThrow();
      const deviceId = randomUUID();
      const key = randomBytes(KEY_BYTES).toString('base64url');
      await trx
        .insertInto('upload_device')
        .values({
          id: deviceId,
          household_id: at.household_id,
          account_id: row.account_id,
          member_id: row.member_id,
          name: input.device_name,
          platform: input.platform,
          key_hash: deviceKeyHash(deviceId, key),
        })
        .execute();
      await appendAudit(trx, {
        householdId: at.household_id,
        actorAccountId: row.account_id,
        action: 'computer.paired',
        objectType: 'member',
        objectId: row.member_id,
        detail: { name: input.device_name, platform: input.platform },
        ip: meta.ip,
      });
      return {
        kind: 'paired',
        accountId: row.account_id,
        name: input.device_name,
        answer: {
          device_id: deviceId,
          key,
          member_name: person.display_name,
          vault_name: household.name,
        },
      };
    });
    if (outcome.kind === 'wrong') throw wrongCode();
    if (outcome.kind === 'refused') throw outcome.error;
    // Told by email (the alert's own path, and its rules: never to a lock
    // screen), once the key is made.
    await this.opts
      .alert({
        householdId: at.household_id,
        accountIds: [outcome.accountId],
        subject: 'A computer was added to your sign-in',
        body: `A computer was added to your sign-in: ${outcome.name}. It can send scans into your uploads, and nothing else. If this wasn't you, remove it in Settings → Your computers.`,
        emailOnly: true,
      })
      .catch(() => undefined);
    return outcome.answer;
  }

  // ------------------------------------------------------------- the key

  /**
   * Whoever `Authorization: Device <id>.<key>` is: its computer and its
   * person, as they are now. A key the vault does not know is `401
   * unauthenticated`; one revoked, `401 device_revoked`. Its last use is
   * noted.
   */
  async authenticate(header: string | undefined): Promise<DeviceCaller> {
    const m = /^Device ([^.\s]+)\.(\S+)$/.exec(header ?? '');
    const id = m?.[1];
    const key = m?.[2];
    if (!id || !key || !UUID.test(id) || !KEY_TEXT.test(key)) throw unknownKey();
    const hash = deviceKeyHash(id.toLowerCase(), key);
    const found = await sql<{ household_id: string; revoked: boolean }>`
      select household_id, revoked from upload_device_find(${id}::uuid, ${hash})`.execute(this.db);
    const at = found.rows[0];
    if (!at) throw unknownKey();
    if (at.revoked) throw revoked();
    return withSystem(this.db, at.household_id, async (trx) => {
      const row = await trx
        .selectFrom('upload_device as d')
        .innerJoin('member as m', (j) =>
          j.onRef('m.id', '=', 'd.member_id').onRef('m.household_id', '=', 'd.household_id'),
        )
        .leftJoin('account_household as a', (j) =>
          j
            .onRef('a.account_id', '=', 'd.account_id')
            .onRef('a.household_id', '=', 'd.household_id'),
        )
        .select([
          'd.id',
          'd.name',
          'd.account_id',
          'd.member_id',
          'd.revoked_at',
          'm.display_name',
          'a.role',
          'a.suspended_at',
          'a.suspended_until',
          'a.suspend_reason',
        ])
        .where('d.id', '=', id)
        .executeTakeFirst();
      if (!row || row.revoked_at !== null || !row.role) throw revoked();
      await trx
        .updateTable('upload_device')
        .set({ last_used_at: sql<Date>`now()` })
        .where('id', '=', row.id)
        .execute();
      const role = row.role;
      return {
        deviceId: row.id,
        householdId: at.household_id,
        accountId: row.account_id,
        memberId: row.member_id,
        role,
        name: row.name,
        memberName: row.display_name,
        paused: pausedFor({
          role,
          suspend_reason: row.suspend_reason ?? null,
          suspended_at: row.suspended_at ?? null,
          suspended_until: row.suspended_until ?? null,
        }),
      };
    });
  }

  /** GET /devices/me: what the app may say about itself, and why its files would be refused. */
  me(c: DeviceCaller): DeviceMe {
    return {
      device_id: c.deviceId,
      device_name: c.name,
      member_name: c.memberName,
      active: c.paused === null,
      paused: c.paused,
      limits: {
        max_upload_bytes: this.opts.maxUploadBytes,
        batch_max_files: BATCH_MAX_FILES,
        accepted_types: Object.keys(UPLOAD_KINDS),
      },
    };
  }

  /** The person a key is, as the batches see them: asking as themselves, with no session. */
  private principalOf(c: DeviceCaller): Principal {
    return {
      accountId: c.accountId,
      sessionId: '',
      householdId: c.householdId,
      memberId: c.memberId,
      role: c.role,
      seesAdults: seesAdults(c.role, null),
    };
  }

  /**
   * POST /device-uploads: one file into its person's batch for the day,
   * through the path every upload to a batch takes. A repeat of an
   * Idempotency-Key it sent before answers the item that file made.
   */
  async upload(
    c: DeviceCaller,
    upload: BatchUpload & { idempotencyKey: string },
    meta: RequestMeta,
  ): Promise<{ answer: DeviceUploaded; replayed: boolean }> {
    if (c.paused) throw pausedRefusal(c.paused);
    const p = this.principalOf(c);
    const batchId = await this.batches.deviceBatch(
      p,
      { id: c.deviceId, name: c.name },
      upload.idempotencyKey,
    );
    const { item, replayed } = await this.batches.addItem(
      p,
      batchId,
      {
        ...upload,
        // The key still live, held while the file's row is made.
        stillAllowed: async (trx) => {
          const live = await trx
            .selectFrom('upload_device')
            .select('id')
            .where('id', '=', c.deviceId)
            .where('revoked_at', 'is', null)
            .forShare()
            .executeTakeFirst();
          if (!live) throw revoked();
        },
      },
      meta,
    );
    return { answer: { item_id: item.id, status: item.state }, replayed };
  }

  // --------------------------------------------------------- managing them

  /**
   * GET /paired-devices: the caller's own computers; an owner, every
   * computer in the household — by name and person, and when somebody
   * else's was last used never. Revoked ones are not listed.
   */
  async list(p: Principal): Promise<PairedDevice[]> {
    this.mayAdd(p);
    const rows = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('upload_device as d')
        .innerJoin('member as m', (j) =>
          j.onRef('m.id', '=', 'd.member_id').onRef('m.household_id', '=', 'd.household_id'),
        )
        .select([
          'd.id',
          'd.name',
          'd.platform',
          'd.member_id',
          'd.account_id',
          'd.created_at',
          'd.last_used_at',
          'm.display_name',
        ])
        .where('d.revoked_at', 'is', null)
        .orderBy('d.created_at', 'desc')
        .execute(),
    );
    return rows.map((r) => {
      const mine = r.account_id === p.accountId;
      return {
        id: r.id,
        name: r.name,
        platform: r.platform,
        member_id: r.member_id,
        member_name: r.display_name,
        mine,
        added_at: r.created_at.toISOString(),
        last_used_at: mine && r.last_used_at ? r.last_used_at.toISOString() : null,
      };
    });
  }

  /**
   * DELETE /paired-devices/{id}: a computer's key revoked, for good — the
   * caller's own, or, for an owner, anybody's. Anybody else's is not here.
   */
  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    this.mayAdd(p);
    await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('upload_device')
        .select(['id', 'name', 'platform', 'account_id', 'member_id'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notHere();
      const own = row.account_id === p.accountId;
      if (!own && p.role !== 'owner') throw notHere();
      await trx
        .updateTable('upload_device')
        .set({
          revoked_at: sql<Date>`now()`,
          revoked_by: p.accountId,
          revoked_reason: own ? 'member' : 'owner',
        })
        .where('id', '=', row.id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'computer.revoked',
        objectType: 'member',
        objectId: row.member_id,
        detail: { name: row.name, platform: row.platform, reason: own ? 'member' : 'owner' },
        ip: meta.ip,
      });
    });
  }
}

/**
 * The activity log's lines for what the database revoked in this very
 * transaction (0070's upload_devices_leave_with_role): a sign-in taken
 * away, or a role that can no longer add. Asked by whoever changed it,
 * after the change, inside its transaction.
 */
export async function logDevicesEnded(
  trx: Db,
  p: Principal,
  person: { account_id: string; member_id: string },
  meta: RequestMeta,
): Promise<number> {
  const ended = await trx
    .selectFrom('upload_device')
    .select(['name', 'platform', 'revoked_reason'])
    .where('account_id', '=', person.account_id)
    .where('revoked_at', '=', sql<Date>`now()`)
    .where('revoked_reason', 'in', ['sign_in_removed', 'cannot_add'])
    .orderBy('created_at')
    .execute();
  for (const d of ended) {
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'computer.revoked',
      objectType: 'member',
      objectId: person.member_id,
      detail: { name: d.name, platform: d.platform, reason: d.revoked_reason },
      ip: meta.ip,
    });
  }
  return ended.length;
}
