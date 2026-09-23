import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { EncryptStream, newKey, unwrapKey, wrapKey, type ScopeKeys } from '@fdv/crypto';
import { withHousehold, type Db } from '@fdv/db';
import { formatDate, type DateValue } from '@fdv/shared';
import { adapterFromRow } from '@fdv/storage';
import { decryptToBuffer } from './process-version.js';
import { sql } from 'kysely';

/**
 * Full export (STO-07, design principle 7): a ZIP with every original the
 * requester can see, plus `index.csv`, `index.json` and a browsable
 * `index.html`. The ZIP is stored encrypted in the vault under the
 * household key and served decrypted like any version; it expires after a
 * week. The export format is also the future import format.
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
  issued: string | null;
  expires: string | null;
  identifier: string | null;
  physical_location: string | null;
  tags: string[];
  notes: string | null;
  file: string | null;
  version_no: number | null;
  sha256: string | null;
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
    withHousehold(deps.db, hh, (trx) =>
      trx
        .updateTable('export')
        .set({ state, ...extra } as never)
        .where('id', '=', export_id)
        .execute(),
    );
  await mark('running');

  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-export-'));
  try {
    const ctx = await withHousehold(deps.db, hh, async (trx) => {
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
      const hhKey = await deps.keys.unwrap(trx, { householdId: hh, kind: 'household' });
      const active = await trx
        .selectFrom('household')
        .select('active_vault_id')
        .where('id', '=', hh)
        .executeTakeFirstOrThrow();
      return { docs, members, versions, vaults, hhKey, activeVaultId: active.active_vault_id, exp };
    });

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
        const scopeKey = await withHousehold(deps.db, hh, (trx) =>
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
        issued: dateOf(d.issued_on, d.issued_precision),
        expires: dateOf(d.expires_on, d.expires_precision),
        identifier: d.identifier,
        physical_location: d.physical_location,
        tags: d.tags,
        notes: d.notes,
        file,
        version_no: v?.version_no ?? null,
        sha256: v ? v.sha256.toString('hex') : null,
      });
    }

    archive.append(
      JSON.stringify({ exported_at: new Date().toISOString(), documents: entries }, null, 2),
      { name: 'index.json' },
    );
    archive.append(csv(entries), { name: 'index.csv' });
    archive.append(html(entries), { name: 'index.html' });
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
      file_key_wrapped: wrapKey(fileKey, ctx.hhKey.key, `export:${export_id}`),
      wrapped_by_scope: ctx.hhKey.id,
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

function csv(entries: Entry[]): string {
  const cols: Array<keyof Entry> = [
    'title',
    'type_key',
    'category',
    'person',
    'visibility',
    'issued',
    'expires',
    'identifier',
    'physical_location',
    'tags',
    'notes',
    'file',
    'version_no',
    'sha256',
    'document_id',
  ];
  const cell = (v: string | number | string[] | null) => {
    const s = Array.isArray(v) ? v.join(' ') : v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [cols.join(','), ...entries.map((e) => cols.map((c) => cell(e[c])).join(','))].join('\n') + '\n'
  );
}

function html(entries: Entry[]): string {
  const esc = (s: string | number | null) =>
    String(s ?? '').replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    );
  const rows = entries
    .map(
      (e) =>
        `<tr><td>${e.file ? `<a href="${esc(e.file)}">${esc(e.title)}</a>` : esc(e.title)}</td><td>${esc(e.category)}</td><td>${esc(e.person)}</td><td>${esc(e.expires)}</td><td>${esc(e.identifier)}</td><td>${esc(e.physical_location)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Family Document Vault export</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#1c1a17;background:#faf8f4}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e0d6}th{font-size:13px;color:#5e574e}h1{font-weight:600}</style></head>
<body><h1>Family Document Vault export</h1><p>${entries.length} document${entries.length === 1 ? '' : 's'}. Files are in folders by category; this page and index.csv list what each one is.</p>
<table><thead><tr><th>Document</th><th>Category</th><th>Person</th><th>Expires</th><th>Number</th><th>Original is kept</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>\n`;
}

const README = `This folder is a complete export from Family Document Vault.

- Each file is the original as it was uploaded, in a folder named after its category.
- index.html opens in any browser and lists every document with its details.
- index.csv is the same list for a spreadsheet; index.json is the same list for software.
- Nothing here depends on the vault software. Keep it somewhere safe.
`;
