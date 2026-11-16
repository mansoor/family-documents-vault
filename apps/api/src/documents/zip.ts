import type { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { DecryptStream, openPrivate, unwrapKey, type ScopeKeys } from '@fdv/crypto';
import { appendAuditMany, householdToday, withPrincipal, type AuditInput, type Db } from '@fdv/db';
import { StorageError } from '@fdv/storage';
import {
  csvCell,
  formatDate,
  NOTE_KIND,
  noteMarkdown,
  recordFileName,
  safeExtension,
  safeFileName,
  ZIP_LEFT_OUT,
  ZIP_MAX_BYTES,
  ZIP_MAX_DOCUMENTS,
  zipFileName,
  zipNames,
  zipTooLarge,
  type DateValue,
  type ZipLeftOut,
} from '@fdv/shared';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { StepUpAction } from '../auth/step-up.js';
import { allows } from '../authz.js';
import { seenCollection } from '../collections/seen.js';
import { ApiError, notFound } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { sensitiveSql } from './filters.js';
import {
  byGrant,
  readDocument,
  recordCaregiverLook,
  seenDocument,
  type DocumentService,
} from './service.js';

/**
 * Several documents as one ZIP (0.9.0, DL; FND-05): the ticked rows of the
 * Documents table, or a whole collection, for somebody signed in. A link's
 * own (everything a share link gives) is the share service's, which keeps
 * a link's sessions; the ZIP itself is written here for both.
 *
 * Each document goes in only if its single download would give it — the
 * reading rule (`readDocument`: a caregiver's grant too), its newest
 * version's file — and is written down as that download is
 * (`document.downloaded`, a caregiver's look). One the caller can see but
 * not download (a note, a file removed for good) is named in the index;
 * one they cannot see is not there at all. Nothing is widened: the question
 * a single download asks (an Only me or an Essential document) is asked of
 * the whole, and a Sensitive one asks to confirm it's you too.
 *
 * The files are decrypted as the ZIP is written, one after another, and
 * never held whole in memory.
 */

/** A file to go in: its name in the ZIP, and its plaintext when it is reached. */
export interface ZipFile {
  name: string;
  open: () => Promise<Readable | string>;
  /** Its line of the index: told it was not there, if its file is not found as it is written. */
  row?: ZipIndexRow;
}

/** One line of the index: what the document is, and where it is in the ZIP or why not. */
export interface ZipIndexRow {
  title: string;
  kind: string | null;
  /** Signed in only: a link's index says no more than its page. */
  person?: string | null;
  issued?: string | null;
  expires?: string | null;
  file: string | null;
  left_out: ZipLeftOut | null;
}

export interface ZipPlan {
  /** The ZIP's own name, as the browser saves it. */
  filename: string;
  /** The heading of its index: whose and what. */
  heading: string;
  /** Whether the index has a person and dates (signed in), or only what a link's page says. */
  full: boolean;
  rows: ZipIndexRow[];
  files: ZipFile[];
}

/** `422 zip_too_large`, said in words, pointing to Settings → Export for whoever may export. */
export const zipRefused = (mayExport: boolean) =>
  new ApiError(422, 'zip_too_large', zipTooLarge(mayExport));

/** Nothing in it has a file the caller may download. */
export const nothingToZip = () =>
  new ApiError(422, 'nothing_to_zip', 'None of these has a file you can download.');

/** A file's plaintext, decrypted as it is read: the single download's own way. */
export function decryptedFile(
  adapter: { get(key: string): Promise<Readable> },
  storageKey: string,
  fileKey: Buffer,
): () => Promise<Readable> {
  return async () => {
    const cipher = await adapter.get(storageKey);
    const dec = new DecryptStream(fileKey);
    cipher.on('error', (e) => dec.destroy(e));
    return cipher.pipe(dec);
  };
}

/** What one ZIP holds: the release's, which a test may lower to try the cap. */
export const zipLimits = { documents: ZIP_MAX_DOCUMENTS, bytes: ZIP_MAX_BYTES };

/** Whether a ZIP of these files is within what one holds. */
export function withinZipLimits(files: ReadonlyArray<{ byte_size: number }>): boolean {
  const bytes = files.reduce((n, f) => n + f.byte_size, 0);
  return files.length <= zipLimits.documents && bytes <= zipLimits.bytes;
}

const esc = (s: string | null | undefined) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** index.csv: one row a document, as a spreadsheet opens it (the export's own cell rule). */
export function indexCsv(plan: Pick<ZipPlan, 'rows' | 'full'>): string {
  const header = plan.full
    ? ['Title', 'Kind', 'Person', 'Issued', 'Expires', 'File in this ZIP', 'Note']
    : ['Title', 'Kind', 'File in this ZIP', 'Note'];
  const row = (r: ZipIndexRow) =>
    (plan.full
      ? [r.title, r.kind, r.person, r.issued, r.expires, r.file, note(r)]
      : [r.title, r.kind, r.file, note(r)]
    ).map((v) => csvCell(v ?? null));
  return (
    [header.map(csvCell).join(','), ...plan.rows.map((r) => row(r).join(','))].join('\n') + '\n'
  );
}

const note = (r: ZipIndexRow) => (r.left_out ? ZIP_LEFT_OUT[r.left_out] : null);

/** index.html: the same list, opened in any browser, each file a link to itself. */
export function indexHtml(plan: Pick<ZipPlan, 'rows' | 'full' | 'heading'>): string {
  const included = plan.rows.filter((r) => r.file).length;
  const head = plan.full
    ? '<th>Document</th><th>Kind</th><th>Person</th><th>Issued</th><th>Expires</th><th>File</th>'
    : '<th>Document</th><th>Kind</th><th>File</th>';
  const rows = plan.rows
    .map((r) => {
      const title = `${esc(r.title)}${r.left_out ? `<br><small>${esc(note(r))}</small>` : ''}`;
      const file = r.file ? `<a href="${esc(encodeURI(r.file))}">${esc(r.file)}</a>` : '';
      return plan.full
        ? `<tr><td>${title}</td><td>${esc(r.kind)}</td><td>${esc(r.person)}</td><td>${esc(r.issued)}</td><td>${esc(r.expires)}</td><td>${file}</td></tr>`
        : `<tr><td>${title}</td><td>${esc(r.kind)}</td><td>${file}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(plan.heading)}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#1c1a17;background:#faf8f4}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e0d6;vertical-align:top}th{font-size:13px;color:#5e574e}h1{font-weight:600}small{color:#5e574e}</style></head>
<body><h1>${esc(plan.heading)}</h1><p>${included} file${included === 1 ? '' : 's'} in this download. This page and index.csv list what each one is.</p>
<table><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table></body></html>\n`;
}

/** Whether a file's storage says it is not there (the full export's FILE_NOT_THERE). */
export const notThere = (err: unknown) => err instanceof StorageError && err.code === 'not_found';

/**
 * The ZIP, written as it is read: each file in turn — opened only when the
 * one before it is all in, so a slow reader holds back the files, not
 * memory — then the index, last, so it says what is really in it. A file
 * not where the files are kept is left out, its line saying so, and the
 * rest go on; one that fails part-way ends the ZIP with it. A reader that
 * goes away stops it, and the file being opened then is closed.
 */
export function zipStream(plan: ZipPlan, onError?: (err: unknown) => void): Readable {
  // Most papers are PDFs and photos, which squeeze little: a light level.
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const add = (source: Readable | string, name: string) =>
    new Promise<void>((resolve, reject) => {
      const done = () => {
        archive.off('entry', done);
        archive.off('close', gone);
        archive.off('error', failed);
        resolve();
      };
      const gone = () => {
        archive.off('entry', done);
        archive.off('error', failed);
        reject(new Error('the ZIP was closed before it was written'));
      };
      const failed = (err: Error) => {
        archive.off('entry', done);
        archive.off('close', gone);
        reject(err);
      };
      archive.once('entry', done);
      archive.once('close', gone);
      archive.once('error', failed);
      archive.append(source, { name });
    });
  void (async () => {
    try {
      for (const f of plan.files) {
        if (archive.destroyed) return;
        let source: Readable | string;
        try {
          source = await f.open();
        } catch (err) {
          if (!notThere(err)) throw err;
          // Not where the files are kept (the full export's FILE_NOT_THERE):
          // said in the index, and the rest go on.
          if (f.row) {
            f.row.file = null;
            f.row.left_out = 'not_there';
          }
          continue;
        }
        // Gone while it was being opened: nothing more is read of it.
        if (archive.destroyed) {
          if (typeof source !== 'string') source.destroy();
          return;
        }
        try {
          await add(source, f.name);
        } catch (err) {
          if (typeof source !== 'string') source.destroy();
          throw err;
        }
      }
      await add(indexHtml(plan), 'index.html');
      await add(indexCsv(plan), 'index.csv');
      await archive.finalize();
    } catch (err) {
      if (!archive.destroyed) {
        onError?.(err);
        archive.destroy(err as Error);
      }
    }
  })();
  return archive;
}

/** A date as the index says it: "3 March 2031", "March 2031", "2031". */
function dateOf(d: string | null, precision: DateValue['precision'] | null): string | null {
  if (!d || !precision) return null;
  return formatDate({ date: String(d).slice(0, 10), precision });
}

/** The question the whole asks: Sensitive first (DL), then what a single download asks (SEC-17). */
export function zipStepUp(
  rows: ReadonlyArray<{ sensitive_now: boolean; visibility: string; is_essential: boolean }>,
): StepUpAction | null {
  if (rows.some((r) => r.sensitive_now)) return 'download_sensitive';
  if (rows.some((r) => r.visibility === 'private')) return 'open_private_document';
  if (rows.some((r) => r.is_essential)) return 'open_essential';
  return null;
}

/** Asks a fresh credential for `action`, in the caller's own transaction; throws `step_up_required`. */
export type ZipAsk = (action: StepUpAction, trx: Db) => Promise<void>;

export class ZipService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    private readonly documents: DocumentService,
  ) {}

  /**
   * POST /documents/download: the ticked rows, in the order given. An id the
   * caller cannot read is not there; none at all is a 404, as one document
   * would be.
   */
  async selection(
    p: Principal,
    ids: string[],
    ask: ZipAsk,
    meta: RequestMeta,
    opts: { checkOnly?: boolean } = {},
  ): Promise<ZipPlan> {
    const asked = [...new Set(ids.map((i) => i.toLowerCase()))];
    // Its kinds' names, as the caller is given them: the household's own too.
    const kinds = await this.kindLabels(p);
    return withPrincipal(this.db, p, async (trx) => {
      const today = await householdToday(trx);
      return this.plan(trx, p, asked, kinds, ask, meta, opts.checkOnly === true, {
        filename: zipFileName(null, today),
        heading: `Family documents, ${formatDate({ date: today, precision: 'day' })}`,
        whenNone: () => notFound('Those documents'),
      });
    });
  }

  /**
   * POST /collections/{id}/download: every document in the collection the
   * caller is given — as the collection shows them, out of the Trash, in its
   * order. A collection they may not see is a 404, as it is everywhere.
   */
  async collection(
    p: Principal,
    collectionId: string,
    ask: ZipAsk,
    meta: RequestMeta,
    opts: { checkOnly?: boolean } = {},
  ): Promise<ZipPlan> {
    const kinds = await this.kindLabels(p);
    return withPrincipal(this.db, p, async (trx) => {
      const found = await trx
        .selectFrom('doc_collection as l')
        .select(['l.id', 'l.name'])
        .where('l.id', '=', collectionId)
        .where(seenCollection(p))
        .executeTakeFirst();
      if (!found) throw notFound('That collection');
      const ids = (
        await trx
          .selectFrom('doc_collection_item as i')
          .innerJoin('document as d', 'd.id', 'i.document_id')
          .select('d.id')
          .where('i.collection_id', '=', found.id)
          .where('d.deleted_at', 'is', null)
          .where(seenDocument(p))
          .orderBy('i.position')
          .orderBy('i.document_id')
          .execute()
      ).map((r) => r.id);
      const today = await householdToday(trx);
      return this.plan(trx, p, ids, kinds, ask, meta, opts.checkOnly === true, {
        filename: zipFileName(found.name, today),
        heading: found.name,
        whenNone: nothingToZip,
      });
    });
  }

  private async kindLabels(p: Principal): Promise<Map<string, string>> {
    const types = await this.documents.types(p, { all: true });
    return new Map(types.map((t) => [t.key, t.label]));
  }

  private async plan(
    trx: Db,
    p: Principal,
    ids: string[],
    kinds: Map<string, string>,
    ask: ZipAsk,
    meta: RequestMeta,
    /** Asked only: what it would refuse, and what it would ask, with nothing written down. */
    checkOnly: boolean,
    named: { filename: string; heading: string; whenNone: () => ApiError },
  ): Promise<ZipPlan> {
    if (ids.length === 0) throw named.whenNone();
    // By the reading rule, as the single download reads (a caregiver's
    // grant too); in the Trash too, as that download is given.
    const docs = await trx
      .selectFrom('document as d')
      .leftJoin('member as m', 'm.id', 'd.owner_member_id')
      .select([
        'd.id',
        'd.title',
        'd.type_key',
        'd.visibility',
        'd.is_essential',
        'd.owner_member_id',
        'd.household_owned',
        'd.issued_on',
        'd.issued_precision',
        'd.expires_on',
        'd.expires_precision',
        'm.display_name as person',
        'd.notes',
        'd.notes_sealed',
      ])
      .select(sensitiveSql('d').as('sensitive_now'))
      .where('d.id', 'in', ids)
      .where(readDocument(p, 'd'))
      .execute();
    if (docs.length === 0) throw named.whenNone();
    const byId = new Map(docs.map((d) => [d.id.toLowerCase(), d]));
    const newest = new Map<string, NewestVersion>();
    for (const v of await trx
      .selectFrom('document_version')
      .select([
        'id',
        'document_id',
        'version_no',
        'filename',
        'mime',
        'byte_size',
        'storage_key',
        'vault_id',
        'file_key_wrapped',
        'wrapped_by_scope',
        'file_removed_at',
      ])
      .where(
        'document_id',
        'in',
        docs.map((d) => d.id),
      )
      .orderBy('document_id')
      .orderBy('version_no', 'desc')
      .execute()) {
      if (!newest.has(v.document_id)) newest.set(v.document_id, v);
    }

    // In the order asked; each one either in, or named as left out.
    const ordered = ids.map((i) => byId.get(i)).filter((d) => d !== undefined);
    // A note (N1) goes in as its words, a Markdown file, where the caller
    // may read them: its words unsealed, or their own Only me note's.
    const notesOpen = (d: (typeof docs)[number]) =>
      !d.notes_sealed || d.owner_member_id === p.memberId;
    const going = ordered.filter((d) => {
      if (d.type_key === NOTE_KIND) return notesOpen(d);
      const v = newest.get(d.id);
      return v && !v.file_removed_at;
    });
    if (going.length === 0) throw nothingToZip();
    if (
      !withinZipLimits(
        going.map((d) => ({
          byte_size:
            d.type_key === NOTE_KIND
              ? Buffer.byteLength(d.notes ?? '')
              : Number(newest.get(d.id)?.byte_size ?? 0),
        })),
      )
    ) {
      throw zipRefused(allows(p, 'export.request'));
    }
    const action = zipStepUp(going);
    if (action) await ask(action, trx);

    const name = zipNames();
    const rows: ZipIndexRow[] = [];
    const adapters = new Map<string, Awaited<ReturnType<VaultService['adapterById']>>>();
    const adapterOf = async (vaultId: string) => {
      let adapter = adapters.get(vaultId);
      if (!adapter) {
        adapter = await this.vaults.adapterById(trx, vaultId);
        adapters.set(vaultId, adapter);
      }
      return adapter;
    };
    // Each one's line of the index, and what is to go in: nothing written
    // down yet, and nothing held.
    type Going = { d: (typeof docs)[number]; row: ZipIndexRow; v: NewestVersion | null };
    const goingIn: Going[] = [];
    for (const d of ordered) {
      const v = newest.get(d.id);
      const row: ZipIndexRow = {
        title: d.title ?? 'Untitled',
        kind:
          d.type_key === NOTE_KIND ? 'Note' : d.type_key ? (kinds.get(d.type_key) ?? null) : null,
        person: d.household_owned ? 'The household' : (d.person ?? null),
        issued: dateOf(d.issued_on, d.issued_precision),
        expires: dateOf(d.expires_on, d.expires_precision),
        file: null,
        left_out: null,
      };
      rows.push(row);
      if (d.type_key === NOTE_KIND) {
        if (notesOpen(d)) goingIn.push({ d, row, v: null });
        else row.left_out = 'note';
      } else if (!v) {
        row.left_out = 'no_file';
      } else if (v.file_removed_at) {
        row.left_out = 'removed';
      } else {
        goingIn.push({ d, row, v });
      }
    }
    if (checkOnly) {
      return { filename: named.filename, heading: named.heading, full: true, rows, files: [] };
    }
    // A file not where the files are kept is left out before anything is
    // written down about it (the full export's FILE_NOT_THERE): not
    // logged as downloaded, and the rest go on.
    const there: Going[] = [];
    for (const g of goingIn) {
      if (g.v) {
        const adapter = await adapterOf(g.v.vault_id);
        try {
          await adapter.stat(g.v.storage_key);
        } catch (err) {
          if (!notThere(err)) throw err;
          g.row.left_out = 'not_there';
          continue;
        }
      }
      there.push(g);
    }
    if (there.length === 0) throw nothingToZip();
    // The documents first, then the log (holdForReading's rule, the I3
    // check): every one held, in one order, before the log is; a document
    // taken away meanwhile is left out.
    const held = new Set(
      (
        await trx
          .selectFrom('document')
          .select('id')
          .where(
            'id',
            'in',
            there.map((g) => g.d.id),
          )
          .orderBy('id')
          .forKeyShare()
          .execute()
      ).map((r) => r.id),
    );
    const files: ZipFile[] = [];
    const lines: AuditInput[] = [];
    for (const { d, row, v } of there) {
      if (!held.has(d.id)) {
        rows.splice(rows.indexOf(row), 1);
        continue;
      }
      if (!v) {
        // A note: its words, its owner's Only me ones opened for them.
        let words = d.notes;
        if (d.notes_sealed) {
          const key = await this.keys.unwrap(trx, {
            householdId: p.householdId,
            kind: 'member',
            memberId: d.owner_member_id,
          });
          words = openPrivate(key.key, d.id, {
            notes_sealed: d.notes_sealed,
            extra_sealed: null,
          }).notes;
        }
        const text = noteMarkdown(d.title, words);
        row.file = name(safeFileName(d.title ?? 'Note'), '.md');
        files.push({ name: row.file, open: async () => text, row });
      } else {
        // A caregiver's look for its person (H1b), as the single download's.
        if (byGrant(p, d)) await recordCaregiverLook(trx, d.id, 'downloaded');
        const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
        const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
        const adapter = await adapterOf(v.vault_id);
        // A health record ends as what it is (0.9.0, the H5 review).
        row.file = name(
          safeFileName(d.title ?? 'Untitled'),
          safeExtension(recordFileName(v.filename, v.mime)),
        );
        files.push({ name: row.file, open: decryptedFile(adapter, v.storage_key, fileKey), row });
      }
      // Written down as its single download is (SEC-05): never its contents.
      lines.push({
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.downloaded',
        objectType: 'document',
        objectId: d.id,
        detail: { version_no: v ? v.version_no : null, range: null },
        ip: meta.ip,
      });
    }
    // The log last, in one go.
    if (lines.length > 0) await appendAuditMany(trx, lines);
    return { filename: named.filename, heading: named.heading, full: true, rows, files };
  }
}

interface NewestVersion {
  id: string;
  document_id: string;
  version_no: number;
  filename: string;
  mime: string;
  byte_size: string | number | bigint;
  storage_key: string;
  vault_id: string;
  file_key_wrapped: Buffer;
  wrapped_by_scope: string;
  file_removed_at: Date | null;
}
