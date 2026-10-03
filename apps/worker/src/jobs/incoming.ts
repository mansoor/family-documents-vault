import type https from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, unwrapKey, wrapKey, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withSystem, type Db, type Schema } from '@fdv/db';
import {
  INCOMING_KEEP_DAYS,
  incomingWords,
  PREVIEW_MAX_PAGES,
  type PushMessage,
} from '@fdv/shared';
import { adapterFromRow, StorageError, type StorageAdapter } from '@fdv/storage';
import nodemailer from 'nodemailer';
import { sql, type ExpressionBuilder } from 'kysely';
import type pg from 'pg';
import { liveDevice, openPassword, type VapidKeys } from './notify.js';
import { decryptToBuffer } from './process-version.js';
import { deliver, payloadFor, pushDepsOf, type PushDevice } from './push.js';
import { detectTools, drawable, renderPreviews } from './tools.js';

/**
 * What came in through a request, got ready to be looked at, and looked
 * after until somebody decides about it (5.23).
 *
 *  - `incoming.scan`, sent by the API when a sender presses Finish: each
 *    file is scanned for viruses — by nothing, here: this vault has no
 *    scanner (A42), so it is written down as `unscanned`, and the reviewer
 *    is told so — and then its pages are drawn for review, as a version's
 *    are (previews.ts), under the same ImageMagick limits, encrypted under
 *    the file's own key beside its object. No OCR: a file is read only once
 *    it is filed (version.process). Then its reviewers are told how many
 *    files are waiting for them, and nothing else.
 *  - `incoming.move`, sent by the API when somebody can no longer review
 *    (made a teen or a viewer, their sign-in taken away; locked, from
 *    5.28): what was sent for them alone to review is moved to the owners —
 *    each file's key rewrapped from the requester's own to the adults key,
 *    the request's reviewers made `adults`, and both marked the owners'
 *    alone (0047) — with a line in the activity log, and the owners told.
 *  - `incoming.sweep`, daily: the above for anything a lost job missed; a
 *    file not filed within 30 days of arriving removed, its bytes and its
 *    row; a decided file's bytes whose removal failed, removed; and a
 *    request past its end with nothing waiting and nothing filed from it,
 *    removed with what hangs off it.
 *
 * The order every one of these takes its locks in, as the API's decisions
 * do (apps/api/src/uploads/incoming.ts): a member's membership, then the
 * request, then its files, and the activity log last.
 */

export interface IncomingDeps {
  admin: pg.Pool;
  db: Db;
  keys: ScopeKeys;
  credentialsKey: Buffer;
  localRoot: string;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  /** Telling the reviewers; left out, nobody is told (tests that are about something else). */
  tell?: IncomingTellDeps;
  now?: () => Date;
}

/** How reviewers are told: push to their devices, and the household's own mail server. */
export interface IncomingTellDeps {
  vapid: VapidKeys | null;
  smtpKey: Buffer;
  baseUrl: string;
  agent?: https.Agent;
  allowPrivate?: boolean;
  /** Tests: how one push leaves, in place of the real one. */
  deliver?: typeof deliver;
}

export interface IncomingScanJob {
  household_id: string;
  /** The request whose sender pressed Finish; left out, every file of the household's waiting. */
  request_id?: string;
}

export interface IncomingMoveJob {
  household_id: string;
}

const DAY = 864e5;

/** A page drawn for review, beside its file's object, as a version's are (0027). */
export const incomingPreviewKey = (storageKey: string, n: number) => `${storageKey}.p${n}.enc`;

/**
 * The objects a file has: itself, and every page there could be of it —
 * whatever its row says was drawn, since a drawing that stopped part-way
 * (its worker gone) wrote pages its row never counted (F523-3). A page not
 * there is nothing to remove.
 */
async function removeObjects(adapter: StorageAdapter, f: { storage_key: string }): Promise<void> {
  for (let n = 1; n <= PREVIEW_MAX_PAGES; n++) {
    await adapter.delete(incomingPreviewKey(f.storage_key, n));
  }
  await adapter.delete(f.storage_key);
}

async function adapterOf(trx: Db, deps: IncomingDeps, vaultId: string): Promise<StorageAdapter> {
  const vault = await trx
    .selectFrom('vault')
    .selectAll()
    .where('id', '=', vaultId)
    .executeTakeFirstOrThrow();
  return adapterFromRow(vault, deps.credentialsKey, deps.localRoot);
}

async function putEncrypted(adapter: StorageAdapter, key: string, fileKey: Buffer, plain: Buffer) {
  const enc = new EncryptStream(fileKey);
  await Promise.all([adapter.put(key, enc), pipeline(Readable.from([plain]), enc)]);
}

// ------------------------------------------------------------- the scan

/**
 * Gets the files a sender has sent ready to be looked at: the scan (none,
 * A42), then the review previews; then tells their reviewers. A file
 * decided while its pages were being drawn keeps none of them.
 */
export async function scanIncoming(deps: IncomingDeps, job: IncomingScanJob): Promise<number> {
  const hh = job.household_id;
  const files = await withSystem(deps.db, hh, (trx) => {
    let q = trx
      .selectFrom('incoming_file')
      .select(['id', 'mime', 'storage_key', 'vault_id', 'file_key_wrapped', 'wrapped_by_scope'])
      .where('state', '=', 'received')
      .where('submitted_at', 'is not', null)
      .where((eb) => eb.or([eb('scan_state', '=', 'pending'), undrawn(eb)]));
    if (job.request_id) q = q.where('request_id', '=', job.request_id);
    return q.orderBy('id').execute();
  });
  const ready: string[] = [];
  for (const f of files) {
    // Scanned for nothing: there is no scanner here (A42), and it says so.
    // A file already decided, or removed, is left as it is.
    const marked = await withSystem(deps.db, hh, (trx) =>
      trx
        .updateTable('incoming_file')
        .set({ scan_state: 'unscanned' })
        .where('id', '=', f.id)
        .where('state', '=', 'received')
        .where('scan_state', '=', 'pending')
        .executeTakeFirst(),
    );
    if (Number(marked.numUpdatedRows) === 1) ready.push(f.id);
    await drawIncoming(deps, hh, f);
  }
  // Told once its pages are there: every file ready and not yet told — this
  // job's, and any an earlier one marked and stopped before telling (W523-02).
  await tellWaiting(deps, hh, job.request_id);
  deps.log('info', 'incoming files got ready', { household: hh, files: ready.length });
  return ready.length;
}

/**
 * Tells the reviewers of the files that are ready to be looked at — the
 * scan been, the pages drawn or known not to be — and that nobody has been
 * told of yet: each file taken first (`told_at`), so two jobs never tell of
 * one twice, and then told. A job that stops between the two leaves them
 * taken and untold: a missed push and email, never two. Returns how many.
 */
export async function tellWaiting(
  deps: IncomingDeps,
  hh: string,
  requestId?: string,
): Promise<number> {
  // Nobody to tell with: nothing is taken, so nothing is marked told.
  if (!deps.tell) return 0;
  const taken = await withSystem(deps.db, hh, (trx) => {
    let q = trx
      .updateTable('incoming_file')
      .set({ told_at: new Date() })
      .where('state', '=', 'received')
      .where('submitted_at', 'is not', null)
      .where('scan_state', 'in', ['unscanned', 'clean'])
      .where('preview_state', 'in', ['ready', 'unsupported', 'failed'])
      .where('told_at', 'is', null);
    if (requestId) q = q.where('request_id', '=', requestId);
    return q.returning('id').execute();
  });
  if (taken.length > 0) {
    await tellReviewers(
      deps,
      hh,
      taken.map((f) => f.id),
    );
  }
  return taken.length;
}

/** Not drawn yet, or a drawing that died: begun an hour ago and never finished. */
const undrawn = (eb: ExpressionBuilder<Schema, 'incoming_file'>) =>
  eb.or([
    eb('preview_state', '=', 'none'),
    eb.and([
      eb('preview_state', '=', 'drawing'),
      eb('preview_requested_at', '<', new Date(Date.now() - 3_600_000)),
    ]),
  ]);

/**
 * One file's review pages, drawn and stored; or why there are none. Taken
 * first, so two jobs never draw the same file: the second finds it taken.
 */
async function drawIncoming(
  deps: IncomingDeps,
  hh: string,
  f: {
    id: string;
    mime: string | null;
    storage_key: string;
    vault_id: string;
    file_key_wrapped: Buffer;
    wrapped_by_scope: string;
  },
): Promise<void> {
  const taken = await withSystem(deps.db, hh, (trx) =>
    trx
      .updateTable('incoming_file')
      .set({ preview_state: 'drawing', preview_requested_at: new Date() })
      .where('id', '=', f.id)
      .where('state', '=', 'received')
      .where(undrawn)
      .executeTakeFirst(),
  );
  if (Number(taken.numUpdatedRows) !== 1) return;
  // Only from drawing to an outcome, and only while it is waiting: one
  // decided or removed meanwhile keeps nothing drawn.
  const record = (preview_state: 'ready' | 'unsupported' | 'failed', preview_pages: number) =>
    withSystem(deps.db, hh, (trx) =>
      trx
        .updateTable('incoming_file')
        .set({ preview_state, preview_pages })
        .where('id', '=', f.id)
        .where('state', '=', 'received')
        .where('preview_state', '=', 'drawing')
        .executeTakeFirst(),
    );
  const mime = f.mime ?? '';
  if (!drawable(mime)) {
    await record('unsupported', 0);
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-in-'));
  let ctx: { adapter: StorageAdapter; fileKey: Buffer } | null = null;
  let drawn = 0;
  try {
    ctx = await withSystem(deps.db, hh, async (trx) => {
      const scopeKey = await deps.keys.unwrapById(trx, f.wrapped_by_scope);
      return {
        adapter: await adapterOf(trx, deps, f.vault_id),
        fileKey: unwrapKey(f.file_key_wrapped, scopeKey, `incoming:${f.id}`),
      };
    });
    const tools = await detectTools();
    if (!tools.magick || (mime === 'application/pdf' && !tools.pdftoppm)) {
      throw new Error('the tools to draw pages are not installed');
    }
    const source = path.join(dir, 'source');
    await writeFile(source, await decryptToBuffer(ctx.adapter, f.storage_key, ctx.fileKey));
    const out = await mkdtemp(path.join(dir, 'pages-'));
    // A sender's file, decoded only under MAGICK_LIMITS (tools.ts), as every
    // file the family adds is.
    const pages = await renderPreviews(source, mime, out, PREVIEW_MAX_PAGES);
    if (!pages.length) throw new Error('no pages came out');
    for (const [i, file] of pages.entries()) {
      await putEncrypted(
        ctx.adapter,
        incomingPreviewKey(f.storage_key, i + 1),
        ctx.fileKey,
        await readFile(file),
      );
      drawn = i + 1;
    }
    const kept = await record('ready', pages.length);
    if (Number(kept.numUpdatedRows) !== 1) {
      // Decided, or removed, while they were drawn: whoever did it removed
      // what it knew of, and these were not yet among it.
      for (let n = 1; n <= drawn; n++) {
        await ctx.adapter.delete(incomingPreviewKey(f.storage_key, n)).catch(() => undefined);
      }
    }
  } catch (err) {
    if (ctx && drawn > 0) {
      for (let n = 1; n <= drawn; n++) {
        await ctx.adapter.delete(incomingPreviewKey(f.storage_key, n)).catch(() => undefined);
      }
    }
    await record('failed', 0).catch(() => undefined);
    deps.log('warn', 'could not draw the pages of a file sent in', {
      file: f.id,
      err: (err as Error).message,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------- telling reviewers

/**
 * Tells each reviewer of these files how many files are waiting for them,
 * and nothing else: a push (a phone gets `{v:1, type:'incoming', count}`,
 * a browser a sentence with the count), and an email through the
 * household's own mail server saying the count and where to look. Never
 * who sent them, what they are called, or what the request was.
 */
export async function tellReviewers(
  deps: IncomingDeps,
  hh: string,
  fileIds: readonly string[],
): Promise<{ pushed: number; emailed: number }> {
  const tell = deps.tell;
  if (!tell || fileIds.length === 0) return { pushed: 0, emailed: 0 };
  // Each reviewer of at least one of these, with how many files in all are
  // waiting for them — by the rules the database keeps (0044, 0047).
  const counts = await withSystem(deps.db, hh, async (trx) => {
    const { rows } = await sql<{ account_id: string; email: string; n: number }>`
      select a.account_id, acc.email, count(f.id)::int as n
        from account_household a
        join account acc on acc.id = a.account_id and acc.disabled_at is null
        join incoming_file f on f.household_id = a.household_id
       where a.household_id = ${hh}
         and a.role in ('owner', 'adult')
         and f.state = 'received' and f.submitted_at is not null
         and f.scan_state in ('unscanned', 'clean')
         and case f.review_by
               when 'me' then f.requester_member_id = a.member_id
               when 'adults' then not f.owners_only or a.role = 'owner'
               else false
             end
       group by a.account_id, acc.email
      having bool_or(f.id = any(${[...fileIds]}::uuid[]))`.execute(trx);
    return rows;
  });
  let pushed = 0;
  let emailed = 0;
  for (const c of counts) {
    const message: PushMessage = { v: 1, type: 'incoming', count: c.n };
    pushed += await pushTo(deps, tell, hh, c.account_id, message);
    emailed += await emailTo(deps, tell, hh, c.email, c.n);
  }
  return { pushed, emailed };
}

async function pushTo(
  deps: IncomingDeps,
  tell: IncomingTellDeps,
  hh: string,
  accountId: string,
  message: Extract<PushMessage, { type: 'incoming' }>,
): Promise<number> {
  if (!tell.vapid) return 0;
  const devices = await withSystem(deps.db, hh, (trx) =>
    trx
      .selectFrom('device')
      .select(['id', 'kind', 'endpoint', 'p256dh', 'auth'])
      .where('failed_at', 'is', null)
      .where('kind', 'in', ['web_push', 'unified_push'])
      .where('account_id', '=', accountId)
      .where(liveDevice)
      .execute(),
  );
  const pd = pushDepsOf({ app: deps.db, vapid: tell.vapid, log: deps.log, ...agentOf(tell) });
  const send = tell.deliver ?? deliver;
  let sent = 0;
  for (const d of devices) {
    if (!d.p256dh || !d.auth) continue;
    const device: PushDevice = {
      id: d.id,
      household_id: hh,
      endpoint: d.endpoint,
      p256dh: d.p256dh,
      auth: d.auth,
    };
    const kind = d.kind === 'unified_push' ? 'unified_push' : 'web_push';
    if ((await send(pd, device, payloadFor(kind, message), 'incoming')) === 'sent') sent++;
  }
  return sent;
}

function agentOf(tell: IncomingTellDeps): { agent?: https.Agent; allowPrivate?: boolean } {
  return {
    ...(tell.agent ? { agent: tell.agent } : {}),
    ...(tell.allowPrivate !== undefined ? { allowPrivate: tell.allowPrivate } : {}),
  };
}

/** The email: how many files, and where to look. Nothing else. */
export function incomingEmail(count: number, baseUrl: string) {
  const href = `${baseUrl.replace(/\/+$/, '')}/incoming`;
  const words = incomingWords(count);
  return {
    subject: count === 1 ? 'A file is waiting for you' : 'Files are waiting for you',
    text: `${words}\n\nLook at ${count === 1 ? 'it' : 'them'}: ${href}\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#faf8f4;color:#1c1917;padding:24px">
<p style="margin:0 0 20px;line-height:1.5">${words}</p>
<p><a href="${href}" style="background:#1f5d4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;display:inline-block">Look at ${count === 1 ? 'it' : 'them'}</a></p>
</body></html>`,
  };
}

async function emailTo(
  deps: IncomingDeps,
  tell: IncomingTellDeps,
  hh: string,
  to: string,
  count: number,
): Promise<number> {
  const smtp = await withSystem(deps.db, hh, (trx) =>
    trx.selectFrom('smtp_settings').selectAll().where('household_id', '=', hh).executeTakeFirst(),
  );
  if (!smtp || smtp.status !== 'ok') return 0;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.username && smtp.password_encrypted
      ? {
          auth: {
            user: smtp.username,
            pass: openPassword(tell.smtpKey, smtp.password_encrypted, hh),
          },
        }
      : {}),
  });
  try {
    await transport.sendMail({
      from: `"${smtp.from_name}" <${smtp.from_email}>`,
      to,
      ...incomingEmail(count, tell.baseUrl),
    });
    return 1;
  } catch (err) {
    deps.log('warn', 'the email about files waiting could not be sent', {
      household: hh,
      error: (err as Error).message,
    });
    return 0;
  } finally {
    transport.close();
  }
}

// ------------------------------------------------------------ the move

/**
 * What was sent for one person alone to review, when that person can no
 * longer review it: made the owners'. Per request, in one transaction: the
 * requester's membership held (a role changing waits, and so does this),
 * the request held and asked again, then its waiting files; each file's key
 * rewrapped from the requester's own to the adults key; the request's
 * reviewers made `adults` (its files follow it, by their key to it); every
 * file of it, decided ones too, marked the owners' alone; a request still
 * open closed; and a line in the activity log. The owners are told after.
 */
export async function moveIncoming(deps: IncomingDeps, job: IncomingMoveJob): Promise<number> {
  const hh = job.household_id;
  const candidates = await withSystem(deps.db, hh, (trx) =>
    trx
      .selectFrom('upload_request as r')
      .select(['r.id'])
      .where('r.review_by', '=', 'me')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('account_household as a')
              .select('a.account_id')
              .whereRef('a.account_id', '=', 'r.created_by')
              .whereRef('a.household_id', '=', 'r.household_id')
              .whereRef('a.member_id', '=', 'r.requester_member_id')
              .where('a.role', 'in', ['owner', 'adult']),
          ),
        ),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('incoming_file as f')
            .select('f.id')
            .whereRef('f.request_id', '=', 'r.id')
            .where('f.state', 'in', ['uploading', 'received']),
        ),
      )
      .orderBy('r.id')
      .execute(),
  );
  const moved: string[] = [];
  for (const { id } of candidates) {
    const files = await withSystem(deps.db, hh, async (trx) => {
      const r = await trx
        .selectFrom('upload_request')
        .select([
          'id',
          'created_by',
          'requester_member_id',
          'recipient_label',
          'review_by',
          'closed_at',
          'revoked_at',
        ])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!r || r.review_by !== 'me') return [];
      // Who asked, as they are now, held: a role changing waits for this.
      const asker = await trx
        .selectFrom('account_household')
        .select('role')
        .where('account_id', '=', r.created_by)
        .where('household_id', '=', hh)
        .where('member_id', '=', r.requester_member_id)
        .forShare()
        .executeTakeFirst();
      if (asker && (asker.role === 'owner' || asker.role === 'adult')) return [];
      const held = await trx
        .selectFrom('upload_request')
        .select('id')
        .where('id', '=', id)
        .where('review_by', '=', 'me')
        .forUpdate()
        .executeTakeFirst();
      if (!held) return [];
      // Its waiting files, held: a decision on one waits for this, and this
      // for it. One decided meanwhile is no longer waiting, and stays where
      // it is.
      const waiting = await trx
        .selectFrom('incoming_file')
        .select(['id', 'file_key_wrapped', 'wrapped_by_scope'])
        .where('request_id', '=', id)
        .where('state', 'in', ['uploading', 'received'])
        .orderBy('id')
        .forUpdate()
        .execute();
      if (waiting.length === 0) return [];
      const adults = await deps.keys.unwrap(trx, { householdId: hh, kind: 'adults' });
      // Every write counted: one that a rule quietly turned into nothing
      // would leave a file under a key nobody it is shown to could use.
      const once = (done: { numUpdatedRows: bigint }, what: string) => {
        if (Number(done.numUpdatedRows) !== 1) throw new Error(`moving ${what} changed nothing`);
      };
      for (const f of waiting) {
        const own = await deps.keys.unwrapById(trx, f.wrapped_by_scope);
        const fileKey = unwrapKey(f.file_key_wrapped, own, `incoming:${f.id}`);
        once(
          await trx
            .updateTable('incoming_file')
            .set({
              file_key_wrapped: wrapKey(fileKey, adults.key, `incoming:${f.id}`),
              wrapped_by_scope: adults.id,
              scope: 'adults',
            })
            .where('id', '=', f.id)
            .executeTakeFirst(),
          `file ${f.id}`,
        );
      }
      const now = new Date();
      once(
        await trx
          .updateTable('upload_request')
          .set({
            review_by: 'adults',
            moved_to_owners_at: now,
            // Kept from opening again, should its requester ask again one day.
            ...(r.closed_at === null && r.revoked_at === null
              ? { closed_at: now, closed_reason: 'requester_lost_right' as const }
              : {}),
          })
          .where('id', '=', id)
          .executeTakeFirst(),
        `request ${id}`,
      );
      // Every file of it, as the request: the owners' alone.
      await trx
        .updateTable('incoming_file')
        .set({ owners_only: true })
        .where('request_id', '=', id)
        .execute();
      await appendAudit(trx, {
        householdId: hh,
        action: 'incoming.moved',
        objectType: 'upload_request',
        objectId: id,
        detail: { files: waiting.length, from: r.recipient_label },
      });
      return waiting.map((f) => f.id);
    });
    moved.push(...files);
  }
  if (moved.length > 0) {
    deps.log('info', 'files sent in moved to the owners', { household: hh, files: moved.length });
    await tellReviewers(deps, hh, moved);
  }
  return moved.length;
}

// ----------------------------------------------------------- the sweep

export interface SweepReport {
  purged: number;
  objectsRemoved: number;
  /** Filed versions whose own copy was missing, made again from the file sent in. */
  versionsRepaired: number;
  requestsRemoved: number;
  moved: number;
  scanned: number;
  told: number;
}

/**
 * Each night. Per household: what a lost job missed (a move, a scan, the
 * telling); a file not filed within INCOMING_KEEP_DAYS of arriving,
 * removed — its pages, its object, its row — with a line for each request
 * it came through; a decided file's object whose removal failed after the
 * decision, removed; and a request past its end with nothing waiting and
 * nothing ever filed from it, removed with its items, sessions, codes and
 * refused files. A request something was filed from stays: a document's
 * history says it came through it.
 */
export async function sweepIncoming(deps: IncomingDeps): Promise<SweepReport> {
  const now = deps.now?.() ?? new Date();
  const report: SweepReport = {
    purged: 0,
    objectsRemoved: 0,
    versionsRepaired: 0,
    requestsRemoved: 0,
    moved: 0,
    scanned: 0,
    told: 0,
  };
  const { rows } = await deps.admin.query<{ id: string }>('select id from household');
  for (const { id: hh } of rows) {
    report.moved += await moveIncoming(deps, { household_id: hh });
    report.purged += await purgeOld(deps, hh, now);
    const decided = await removeDecided(deps, hh, now);
    report.objectsRemoved += decided.removed;
    report.versionsRepaired += decided.repaired;
    report.requestsRemoved += await removeEnded(deps, hh, now);
    // A scan whose job was lost: anything sent more than ten minutes ago
    // and still not ready.
    const stale = await withSystem(deps.db, hh, (trx) =>
      trx
        .selectFrom('incoming_file')
        .select('id')
        .where('state', '=', 'received')
        .where('submitted_at', '<', new Date(now.getTime() - 10 * 60_000))
        .where((eb) => eb.or([eb('scan_state', '=', 'pending'), undrawn(eb)]))
        .limit(1)
        .execute(),
    );
    if (stale.length > 0) report.scanned += await scanIncoming(deps, { household_id: hh });
    // A scan that got a file ready and stopped before telling anyone: told
    // now (W523-02).
    report.told += await tellWaiting(deps, hh);
  }
  return report;
}

/** Files not filed within INCOMING_KEEP_DAYS of arriving: bytes and row, request by request. */
async function purgeOld(deps: IncomingDeps, hh: string, now: Date): Promise<number> {
  const before = new Date(now.getTime() - INCOMING_KEEP_DAYS * DAY);
  const requests = await withSystem(deps.db, hh, (trx) =>
    trx
      .selectFrom('incoming_file')
      .select('request_id')
      .distinct()
      .where('state', '=', 'received')
      .where('received_at', '<', before)
      .execute(),
  );
  let purged = 0;
  for (const { request_id } of requests) {
    purged += await withSystem(deps.db, hh, async (trx) => {
      // Held, each: one being filed this moment is waited for, and is then
      // no longer waiting.
      const old = await trx
        .selectFrom('incoming_file')
        .select(['id', 'storage_key', 'vault_id'])
        .where('request_id', '=', request_id)
        .where('state', '=', 'received')
        .where('received_at', '<', before)
        .orderBy('id')
        .forUpdate()
        .execute();
      const gone: string[] = [];
      for (const f of old) {
        // An object that cannot be reached keeps its row, until next time.
        const removed = await adapterOf(trx, deps, f.vault_id)
          .then((a) => removeObjects(a, f))
          .then(
            () => true,
            () => false,
          );
        if (removed) gone.push(f.id);
      }
      if (gone.length === 0) return 0;
      const deleted = await trx
        .deleteFrom('incoming_file')
        .where('id', 'in', gone)
        .where('state', '=', 'received')
        .executeTakeFirst();
      const label = await trx
        .selectFrom('upload_request')
        .select('recipient_label')
        .where('id', '=', request_id)
        .executeTakeFirst();
      await appendAudit(trx, {
        householdId: hh,
        action: 'incoming.purged',
        objectType: 'upload_request',
        objectId: request_id,
        detail: { files: Number(deleted.numDeletedRows), from: label?.recipient_label ?? null },
      });
      return Number(deleted.numDeletedRows);
    });
  }
  return purged;
}

/**
 * A decided file's object and pages, whose removal after the decision
 * failed: removed now. A filed one only once its version's own copy is
 * there: a filing whose answer was lost, its copy taken back by a request
 * that could not tell (F523-2), has the bytes only here — they are copied
 * to the version first, and checked, or the file is kept for next time.
 */
async function removeDecided(
  deps: IncomingDeps,
  hh: string,
  now: Date,
): Promise<{ removed: number; repaired: number }> {
  const left = await withSystem(deps.db, hh, (trx) =>
    trx
      .selectFrom('incoming_file')
      .select(['id', 'state', 'version_id', 'storage_key', 'vault_id'])
      .where('state', 'in', ['accepted', 'rejected'])
      .where('object_removed_at', 'is', null)
      .where('decided_at', '<', new Date(now.getTime() - 10 * 60_000))
      .execute(),
  );
  let removed = 0;
  let repaired = 0;
  for (const f of left) {
    removed += await withSystem(deps.db, hh, async (trx) => {
      const ok = await (async () => {
        const adapter = await adapterOf(trx, deps, f.vault_id);
        if (f.state === 'accepted' && f.version_id) {
          const kept = await keepFiled(trx, deps, adapter, { ...f, version_id: f.version_id });
          if (kept === 'wait') return false;
          if (kept === 'repaired') repaired++;
        }
        await removeObjects(adapter, f);
        return true;
      })().catch(() => false);
      if (!ok) return 0;
      const r = await trx
        .updateTable('incoming_file')
        .set({ object_removed_at: now })
        .where('id', '=', f.id)
        .where('object_removed_at', 'is', null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    });
  }
  return { removed, repaired };
}

const notFound = (err: unknown) => err instanceof StorageError && err.code === 'not_found';

/**
 * Whether a filed file's version has its own copy: there already, or made
 * now from the file sent in (the same encrypted bytes: filing never
 * encrypts again), checked against what the version says it holds. Anything
 * unsure waits for the next sweep, the file kept.
 */
async function keepFiled(
  trx: Db,
  deps: IncomingDeps,
  from: StorageAdapter,
  f: { id: string; version_id: string; storage_key: string },
): Promise<'there' | 'repaired' | 'wait'> {
  const v = await trx
    .selectFrom('document_version')
    .select(['storage_key', 'vault_id', 'cipher_sha256'])
    .where('id', '=', f.version_id)
    .executeTakeFirst();
  // A version removed takes its file's row with it (0047): nothing to keep.
  if (!v) return 'there';
  const to = await adapterOf(trx, deps, v.vault_id);
  const has = await to.stat(v.storage_key).then(
    () => true as const,
    (err: unknown) => (notFound(err) ? (false as const) : null),
  );
  if (has === null) return 'wait';
  if (has) return 'there';
  const source = await from.stat(f.storage_key).then(
    () => true as const,
    (err: unknown) => (notFound(err) ? (false as const) : null),
  );
  // Neither copy is there: nothing this can do, and nothing left to remove.
  if (source === false) return 'there';
  if (source === null) return 'wait';
  const put = await to.put(v.storage_key, await from.get(f.storage_key));
  if (put.sha256 !== v.cipher_sha256.toString('hex')) {
    await to.delete(v.storage_key).catch(() => undefined);
    deps.log('error', 'a filed version had no copy, and the file it came from is not it', {
      file: f.id,
      version: f.version_id,
    });
    return 'wait';
  }
  deps.log('warn', 'a filed version had no copy: made again from the file sent in', {
    file: f.id,
    version: f.version_id,
  });
  return 'repaired';
}

/**
 * A request past its end, with nothing waiting and nothing ever filed from
 * it: removed, and with it its items, sessions, codes and the rows of the
 * files refused (their bytes went when they were). Its lines in the
 * activity log stay in the chain, and are shown to nobody.
 */
async function removeEnded(deps: IncomingDeps, hh: string, now: Date): Promise<number> {
  return withSystem(deps.db, hh, async (trx) => {
    const ended = await trx
      .selectFrom('upload_request as r')
      .select('r.id')
      .where('r.expires_at', '<=', now)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('incoming_file as f')
              .select('f.id')
              .whereRef('f.request_id', '=', 'r.id')
              .where((w) =>
                w.or([
                  w('f.state', 'in', ['uploading', 'received', 'accepted']),
                  // A refused file whose bytes are not known to be gone yet.
                  w('f.object_removed_at', 'is', null),
                ]),
              ),
          ),
        ),
      )
      .forUpdate()
      .skipLocked()
      .execute();
    if (ended.length === 0) return 0;
    const r = await trx
      .deleteFrom('upload_request')
      .where(
        'id',
        'in',
        ended.map((e) => e.id),
      )
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  });
}
