import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import {
  EncryptStream,
  newKey,
  openPrivate,
  unwrapKey,
  wrapKey,
  type PrivateValues,
  type ScopeKeys,
} from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import { formatDate, wellFormedDate, type DateValue, type TypeField } from '@fdv/shared';
import { adapterFromRow } from '@fdv/storage';
import { decryptToBuffer } from './process-version.js';
import { sql } from 'kysely';

/**
 * Full export (STO-07, design principle 7): a ZIP with every original the
 * requester can see, plus `index.csv`, `index.json` and a browsable
 * `index.html`. The export format is also the future import format.
 *
 * It is the requester's alone, and may hold their Only me documents — their
 * notes and details opened for them (0.5.8). So the ZIP is stored encrypted
 * in the vault under the requester's own member key, since 0.5.8, and not
 * the household's: the key every household document is under, which a
 * future escrow of the household's documents would open, is not the key to
 * somebody's Only me ones. It is served decrypted, to them alone, like any
 * version, and expires after a week.
 */

export interface ExportJob {
  household_id: string;
  export_id: string;
}

export interface ExportDeps {
  db: Db;
  keys: ScopeKeys;
  credentialsKey: Buffer;
  localRoot: string;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

interface Entry {
  document_id: string;
  title: string;
  type_key: string | null;
  category: string | null;
  person: string | null;
  visibility: string;
  issued_by: string | null;
  issued: string | null;
  expires: string | null;
  identifier: string | null;
  physical_location: string | null;
  tags: string[];
  notes: string | null;
  /** The type's own details, by field key, as the vault keeps them (0.5.7). */
  extra: Record<string, unknown>;
  file: string | null;
  version_no: number | null;
  sha256: string | null;
}

/** A column for one of the types' details: its key, and the name it is shown by. */
interface DetailColumn {
  key: string;
  label: string;
}

const safe = (s: string) =>
  s
    .replace(/[^\w.'\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';

export async function buildExport(deps: ExportDeps, job: ExportJob): Promise<void> {
  const { household_id: hh, export_id } = job;
  const mark = (state: 'running' | 'done' | 'failed', extra: Record<string, unknown> = {}) =>
    withSystem(deps.db, hh, (trx) =>
      trx
        .updateTable('export')
        .set({ state, ...extra } as never)
        .where('id', '=', export_id)
        .execute(),
    );
  await mark('running');

  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-export-'));
  try {
    const ctx = await withSystem(deps.db, hh, async (trx) => {
      const exp = await trx
        .selectFrom('export')
        .selectAll()
        .where('id', '=', export_id)
        .executeTakeFirstOrThrow();
      const requester = await trx
        .selectFrom('account_household')
        .select(['member_id', 'role'])
        .where('account_id', '=', exp.requested_by)
        .where('household_id', '=', hh)
        .executeTakeFirstOrThrow();
      const adultsOk = requester.role === 'owner' || requester.role === 'adult';
      const docs = await trx
        .selectFrom('document')
        .selectAll()
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('visibility', '=', 'household'),
            ...(adultsOk ? [eb('visibility', '=', 'adults')] : []),
            eb.and([
              eb('visibility', '=', 'private'),
              eb('owner_member_id', '=', requester.member_id),
            ]),
          ]),
        )
        .orderBy('category')
        .orderBy('title')
        .execute();
      const members = await trx.selectFrom('member').select(['id', 'display_name']).execute();
      // What each detail is called: by its type as the household has it,
      // hidden ones too, or else by the attribute library (0.5.7).
      const types = await trx
        .selectFrom('effective_document_type')
        .select(['key', 'fields'])
        .execute();
      const attributes = await trx
        .selectFrom('document_attribute')
        .select(['key', 'label'])
        .execute();
      const versions = await trx
        .selectFrom('document_version')
        .selectAll()
        .where(
          'document_id',
          'in',
          docs.length ? docs.map((d) => d.id) : ['00000000-0000-0000-0000-000000000000'],
        )
        .orderBy('version_no', 'desc')
        .execute();
      const vaults = await trx.selectFrom('vault').selectAll().execute();
      // The requester's own key: what the export is wrapped under, and what
      // their Only me documents' notes and details are sealed under.
      const memberKey = await deps.keys.unwrap(trx, {
        householdId: hh,
        kind: 'member',
        memberId: requester.member_id,
      });
      const active = await trx
        .selectFrom('household')
        .select('active_vault_id')
        .where('id', '=', hh)
        .executeTakeFirstOrThrow();
      return {
        docs,
        members,
        types,
        attributes,
        versions,
        vaults,
        memberKey,
        requesterMember: requester.member_id,
        activeVaultId: active.active_vault_id,
        exp,
      };
    });
    // Each document's notes and details: an Only me one's opened for the
    // requester, whose own it is — nobody else's is in the export at all.
    const values = new Map<string, PrivateValues>(
      ctx.docs.map((d) => {
        const plain = { notes: d.notes, extra: extraOf(d.extra) };
        if (d.visibility !== 'private' || d.owner_member_id !== ctx.requesterMember) {
          return [d.id, plain];
        }
        const sealed = openPrivate(ctx.memberKey.key, d.id, d);
        // Anything the private.seal job had not reached yet, as it is.
        return [
          d.id,
          {
            notes: plain.notes ?? sealed.notes,
            extra: Object.assign(extraOf(sealed.extra), plain.extra),
          },
        ];
      }),
    );
    const valuesOf = (id: string) => values.get(id) ?? { notes: null, extra: extraOf(null) };
    const columns = detailColumns(
      ctx.docs.map((d) => ({ type_key: d.type_key, extra: valuesOf(d.id).extra })),
      ctx.types.map((t) => ({ key: t.key, fields: (t.fields ?? []) as TypeField[] })),
      ctx.attributes,
    );

    const memberName = new Map(ctx.members.map((m) => [m.id, m.display_name]));
    const latestOf = new Map<string, (typeof ctx.versions)[number]>();
    for (const v of ctx.versions) if (!latestOf.has(v.document_id)) latestOf.set(v.document_id, v);
    const adapters = new Map(
      ctx.vaults.map((v) => [v.id, adapterFromRow(v, deps.credentialsKey, deps.localRoot)]),
    );

    // Build the ZIP on disk (plaintext, temp), then encrypt into the vault.
    const zipPath = path.join(dir, 'export.zip');
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const out = createWriteStream(zipPath);
    const done = pipeline(archive, out);

    const entries: Entry[] = [];
    const used = new Set<string>();
    for (const d of ctx.docs) {
      const v = latestOf.get(d.id);
      let file: string | null = null;
      if (v) {
        const scopeKey = await withSystem(deps.db, hh, (trx) =>
          deps.keys.unwrapById(trx, v.wrapped_by_scope),
        );
        const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${d.id}`);
        const adapter = adapters.get(v.vault_id);
        if (adapter) {
          const bytes = await decryptToBuffer(adapter, v.storage_key, fileKey);
          const ext = path.extname(v.filename) || '';
          const base = `${safe(d.category ?? 'other')}/${safe(d.title ?? d.id)}`;
          let name = `${base}${ext}`;
          for (let i = 2; used.has(name); i++) name = `${base} (${i})${ext}`;
          used.add(name);
          archive.append(bytes, { name });
          file = name;
        }
      }
      entries.push({
        document_id: d.id,
        title: d.title ?? 'Untitled',
        type_key: d.type_key,
        category: d.category,
        person: d.owner_member_id ? (memberName.get(d.owner_member_id) ?? null) : null,
        visibility: d.visibility,
        issued_by: d.issued_by,
        issued: dateOf(d.issued_on, d.issued_precision),
        expires: dateOf(d.expires_on, d.expires_precision),
        identifier: d.identifier,
        physical_location: d.physical_location,
        tags: d.tags,
        notes: valuesOf(d.id).notes,
        extra: valuesOf(d.id).extra,
        file,
        version_no: v?.version_no ?? null,
        sha256: v ? v.sha256.toString('hex') : null,
      });
    }

    archive.append(
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          // What each key in a document's `extra` is called.
          details: columns.map(({ key, label }) => ({ key, label })),
          documents: entries,
        },
        null,
        2,
      ),
      { name: 'index.json' },
    );
    archive.append(csv(entries, columns), { name: 'index.csv' });
    archive.append(html(entries, columns), { name: 'index.html' });
    archive.append(README, { name: 'README.txt' });
    await archive.finalize();
    await done;

    const size = (await stat(zipPath)).size;
    const vaultId = ctx.activeVaultId ?? ctx.vaults[0]?.id;
    const adapter = vaultId ? adapters.get(vaultId) : undefined;
    if (!vaultId || !adapter) throw new Error('no vault to store the export in');
    const fileKey = newKey();
    const key = `${hh}/exports/${export_id}.zip.enc`;
    const enc = new EncryptStream(fileKey);
    const { createReadStream } = await import('node:fs');
    await Promise.all([adapter.put(key, enc), pipeline(createReadStream(zipPath), enc)]);

    await mark('done', {
      document_count: entries.length,
      byte_size: size,
      storage_key: key,
      vault_id: vaultId,
      file_key_wrapped: wrapKey(fileKey, ctx.memberKey.key, `export:${export_id}`),
      wrapped_by_scope: ctx.memberKey.id,
      finished_at: new Date(),
      // Seven days — unless the requester was demoted, or lost their
      // sign-in, while this was being built, which already set it to now.
      expires_at: sql`least(coalesce(expires_at, 'infinity'::timestamptz), ${new Date(
        Date.now() + 7 * 24 * 3600 * 1000,
      )})`,
    });
    deps.log('info', 'export built', { export_id, documents: entries.length, bytes: size });
  } catch (err) {
    await mark('failed', { error: (err as Error).message, finished_at: new Date() });
    deps.log('error', 'export failed', { export_id, error: (err as Error).message });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function dateOf(d: string | null, precision: DateValue['precision'] | null): string | null {
  if (!d || !precision) return null;
  return formatDate({ date: d.slice(0, 10), precision });
}

/**
 * A document's details as the database hands them over: an object, or
 * nothing — copied onto no prototype, so a detail a document lacks is
 * nothing, not something every object inherits ("constructor", kept by a
 * vault before 0.5.7, which took any key).
 */
function extraOf(v: unknown): Record<string, unknown> {
  const own = Object.create(null) as Record<string, unknown>;
  if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(own, v);
  return own;
}

/**
 * A column for each detail any exported document has, in the order its
 * type asks for them, named as the type names it (else as the library
 * does, else by its key). Two details called the same are told apart by
 * their keys: "Account (account)", "Account (h_x2k…)".
 */
export function detailColumns(
  docs: ReadonlyArray<{ type_key: string | null; extra: Record<string, unknown> }>,
  types: ReadonlyArray<{ key: string; fields: ReadonlyArray<Pick<TypeField, 'key' | 'label'>> }>,
  library: ReadonlyArray<{ key: string; label: string }>,
): DetailColumn[] {
  const byKey = new Map<string, DetailColumn>();
  for (const d of docs) {
    const fields = types.find((t) => t.key === d.type_key)?.fields ?? [];
    const held = Object.keys(d.extra);
    const ordered = [
      ...fields.map((f) => f.key).filter((k) => held.includes(k)),
      ...held.filter((k) => !fields.some((f) => f.key === k)).sort(),
    ];
    for (const key of ordered) {
      if (byKey.has(key)) continue;
      const named = fields.find((f) => f.key === key) ?? library.find((a) => a.key === key);
      byKey.set(key, { key, label: named?.label ?? key });
    }
  }
  const columns = [...byKey.values()];
  const count = (label: string) => columns.filter((c) => c.label === label).length;
  return columns.map((c) => (count(c.label) > 1 ? { ...c, label: `${c.label} (${c.key})` } : c));
}

/** One detail as a person reads it: a date in words, yes or no; numbers stay numbers. */
function detailValue(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (wellFormedDate(v as DateValue)) return formatDate(v as DateValue);
  return JSON.stringify(v);
}

function csv(entries: Entry[], details: DetailColumn[]): string {
  const cols = [
    'title',
    'type_key',
    'category',
    'person',
    'visibility',
    'issued_by',
    'issued',
    'expires',
    'identifier',
    'physical_location',
    'tags',
    'notes',
  ] as const;
  const tail = ['file', 'version_no', 'sha256', 'document_id'] as const;
  // A detail's name is somebody's writing too, so the header is guarded as
  // every cell is.
  const header = [...cols, ...details.map((c) => c.label), ...tail].map(csvCell);
  const row = (e: Entry) => [
    ...cols.map((c) => csvCell(e[c])),
    ...details.map((c) => csvCell(detailValue(e.extra[c.key]))),
    ...tail.map((c) => csvCell(e[c])),
  ];
  return [header.join(','), ...entries.map((e) => row(e).join(','))].join('\n') + '\n';
}

/**
 * One cell of index.csv. Text a spreadsheet would run as a formula — from
 * =, +, -, @, a tab or a carriage return on — gets an apostrophe in front,
 * so it is shown as the text it is: any member can write a title or an
 * issuer, and the file is opened by whoever asked for the export.
 */
export function csvCell(v: string | number | string[] | null): string {
  let s = Array.isArray(v) ? v.join(' ') : v === null ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function html(entries: Entry[], details: DetailColumn[]): string {
  const esc = (s: string | number | null) =>
    String(s ?? '').replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    );
  // Each document's details, one to a line: "VIN: 1HGCM82633A004352".
  const detailsOf = (e: Entry) =>
    details
      .filter((c) => detailValue(e.extra[c.key]) !== null)
      .map((c) => `${esc(c.label)}: ${esc(detailValue(e.extra[c.key]))}`)
      .join('<br>');
  const rows = entries
    .map(
      (e) =>
        `<tr><td>${e.file ? `<a href="${esc(e.file)}">${esc(e.title)}</a>` : esc(e.title)}</td><td>${esc(e.category)}</td><td>${esc(e.person)}</td><td>${esc(e.expires)}</td><td>${esc(e.identifier)}</td><td>${detailsOf(e)}</td><td>${esc(e.physical_location)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Family Document Vault export</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#1c1a17;background:#faf8f4}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e0d6}th{font-size:13px;color:#5e574e}h1{font-weight:600}</style></head>
<body><h1>Family Document Vault export</h1><p>${entries.length} document${entries.length === 1 ? '' : 's'}. Files are in folders by category; this page and index.csv list what each one is.</p>
<table><thead><tr><th>Document</th><th>Category</th><th>Person</th><th>Expires</th><th>Number</th><th>Details</th><th>Original is kept</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>\n`;
}

const README = `This folder is a complete export from Family Document Vault.

- Each file is the original as it was uploaded, in a folder named after its category.
- index.html opens in any browser and lists every document with its details.
- index.csv is the same list for a spreadsheet; index.json is the same list for software.
- Nothing here depends on the vault software. Keep it somewhere safe.
`;
