import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import {
  EncryptStream,
  memberPhotoBinding,
  newKey,
  openBytes,
  openIdentity,
  openPrivate,
  unwrapKey,
  wrapKey,
  type PrivateValues,
  type ScopeKeys,
} from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import {
  can,
  canSeeIdentity,
  FILE_REMOVED,
  formatDate,
  IDENTITY_FIELDS,
  IDENTITY_ID_LABELS,
  IDENTITY_LISTS,
  identityFilled,
  maskIdentity,
  wellFormedDate,
  type DateValue,
  type IdentityFields,
  type IdentityList,
  type IdentityPart,
  type TypeField,
} from '@fdv/shared';
import { adapterFromRow, StorageError } from '@fdv/storage';
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
 *
 * Since 5.27 it holds people too: `people/<name>.jpg`, each photo the
 * requester may see (A68: the roles of family.details, or their own), and
 * `identity/<name>.json`, each identity record they may read now
 * (canSeeIdentity, under the audience in effect — identity_audience_now()),
 * with a section of index.html for each. The requester's own record comes
 * whole, both parts, every number in it: it is theirs, as an Only me
 * document is. Anybody else's is their shared part as the app shows it —
 * every ID number and hidden field left out, and named in `masked` — since
 * the app shows those only to somebody who confirms it is them with a
 * passkey or a code (A54), each a line the person sees (A38), and an export
 * is asked for with any credential. Nobody else's Only me part is in any
 * export. A narrower audience expires the exports of whoever loses sight
 * (5.26).
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

/** A person, in index.json (5.27): their photo and their identity details, where the export has them. */
interface PersonEntry {
  id: string;
  name: string;
  /** `people/<name>.jpg`: their photo, where the requester may see it (A68). */
  photo: string | null;
  /** `identity/<name>.json`: their identity details, where the requester may read them. */
  identity: string | null;
}

/** One part of a person's identity details, as an export holds it. */
interface IdentityPartOut {
  fields: IdentityFields;
  /** What was left out of somebody else's: `ids.<id>`, `custom.<id>`. Never in one's own. */
  masked?: string[];
}

/** `identity/<name>.json` (5.27). */
interface IdentityRecordOut {
  person: string;
  member_id: string;
  shared: IdentityPartOut | null;
  /** The requester's own Only me part: in their own export, and no one else's. */
  only_me?: IdentityPartOut;
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
  /**
   * Why it has no file, when it had one (5.24): removed for good after the
   * backup the vault was restored from, or not where the files are kept.
   */
  file_note: string | null;
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

/** What an export says of a file not where the files are kept as it was built (5.24). */
export const FILE_NOT_THERE = 'The file was not where your files are kept when this was made.';

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
      const members = await trx
        .selectFrom('member')
        .select(['id', 'display_name'])
        .orderBy('display_name')
        .orderBy('id')
        .execute();
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
      const people = await peopleFor(deps, trx, hh, requester, members);
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
        ...people,
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
      let fileNote: string | null = null;
      // Its record came back with a restore, its file did not (5.24): listed,
      // with no file and why, rather than failing everybody's export.
      if (v?.file_removed_at) fileNote = FILE_REMOVED;
      if (v && !fileNote) {
        const scopeKey = await withSystem(deps.db, hh, (trx) =>
          deps.keys.unwrapById(trx, v.wrapped_by_scope),
        );
        const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${d.id}`);
        const adapter = adapters.get(v.vault_id);
        let bytes: Buffer | null = null;
        if (adapter) {
          // One file not where it is kept — removed for good while this was
          // built, say — is that document's, not the whole export's.
          bytes = await decryptToBuffer(adapter, v.storage_key, fileKey).catch((err: unknown) => {
            if (err instanceof StorageError && err.code === 'not_found') return null;
            throw err;
          });
          if (!bytes) fileNote = FILE_NOT_THERE;
        }
        if (adapter && bytes) {
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
        file_note: fileNote,
        version_no: v?.version_no ?? null,
        sha256: v ? v.sha256.toString('hex') : null,
      });
    }

    // People (5.27): each photo and identity record the requester may have,
    // named as the person is, two the same told apart — and apart from the
    // identity documents' own files, which are in identity/ too.
    const exported = new Map(entries.filter((e) => e.file).map((e) => [e.document_id, e.file]));
    const seen = new Set(ctx.docs.map((d) => d.id));
    const people: PersonEntry[] = [];
    const records: Array<{ record: IdentityRecordOut; own: boolean }> = [];
    const unused = (folder: string, base: string, ext: string) => {
      let name = `${folder}/${base}${ext}`;
      for (let i = 2; used.has(name); i++) name = `${folder}/${base} (${i})${ext}`;
      used.add(name);
      return name;
    };
    for (const m of ctx.members) {
      const base = safe(m.display_name);
      const jpeg = ctx.photos.get(m.id);
      const photo = jpeg ? unused('people', base, '.jpg') : null;
      if (jpeg && photo) archive.append(jpeg, { name: photo });
      const record = identityRecord(m, ctx.identities.get(m.id), ctx.requesterMember, (id) =>
        seen.has(id),
      );
      const identity = record ? unused('identity', base, '.json') : null;
      if (record && identity) {
        archive.append(`${JSON.stringify(record, null, 2)}\n`, { name: identity });
        records.push({ record, own: m.id === ctx.requesterMember });
      }
      people.push({ id: m.id, name: m.display_name, photo, identity });
    }

    archive.append(
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          // What each key in a document's `extra` is called.
          details: columns.map(({ key, label }) => ({ key, label })),
          documents: entries,
          // Each person, with their photo and identity details where the
          // requester may have them (5.27, A68).
          people,
        },
        null,
        2,
      ),
      { name: 'index.json' },
    );
    archive.append(csv(entries, columns), { name: 'index.csv' });
    archive.append(html(entries, columns, people, records, exported), { name: 'index.html' });
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
  // file_note last (5.24): why a document that had a file has none here.
  const tail = ['file', 'version_no', 'sha256', 'document_id', 'file_note'] as const;
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

function html(
  entries: Entry[],
  details: DetailColumn[],
  people: PersonEntry[] = [],
  records: Array<{ record: IdentityRecordOut; own: boolean }> = [],
  exported: Map<string, string | null> = new Map(),
): string {
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
        `<tr><td>${e.file ? `<a href="${esc(e.file)}">${esc(e.title)}</a>` : esc(e.title)}${e.file_note ? `<br><small>${esc(e.file_note)}</small>` : ''}</td><td>${esc(e.category)}</td><td>${esc(e.person)}</td><td>${esc(e.expires)}</td><td>${esc(e.identifier)}</td><td>${detailsOf(e)}</td><td>${esc(e.physical_location)}</td></tr>`,
    )
    .join('\n');
  // People (5.27): their photos, where there are any.
  const withPhotos = people.filter((p) => p.photo);
  const photos = withPhotos.length
    ? `<h2>People</h2><ul class="people">${withPhotos
        .map(
          (p) =>
            `<li><img src="${esc(p.photo)}" alt="" width="96" height="96"><span>${esc(p.name)}</span></li>`,
        )
        .join('')}</ul>\n`
    : '';
  // Each identity record the export holds, a section each.
  const identity = records.length
    ? `<h2>Identity details</h2>${
        records.some((r) => !r.own)
          ? '<p>ID numbers and hidden details of other people are not in this export: open the vault to see them, which asks you to confirm it’s you.</p>'
          : ''
      }\n${records
        .map(({ record, own }) => {
          const rows = [
            ...identityLines(record.shared, false, exported),
            ...identityLines(record.only_me ?? null, true, exported),
          ];
          return `<section><h3>${esc(record.person)}${own ? ' (you)' : ''}</h3><table><tbody>${rows
            .map(
              (r) =>
                `<tr><th scope="row">${esc(r.label)}${r.onlyMe ? ' <small>(Only me)</small>' : ''}</th><td>${r.html}</td></tr>`,
            )
            .join('')}</tbody></table></section>`;
        })
        .join('\n')}\n`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Family Document Vault export</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#1c1a17;background:#faf8f4}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e0d6}th{font-size:13px;color:#5e574e}h1,h2,h3{font-weight:600}tbody th{width:30%}.people{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:16px}.people li{display:flex;flex-direction:column;align-items:center;gap:4px}.people img{border-radius:50%}</style></head>
<body><h1>Family Document Vault export</h1><p>${entries.length} document${entries.length === 1 ? '' : 's'}. Files are in folders by category; this page and index.csv list what each one is.</p>
<table><thead><tr><th>Document</th><th>Category</th><th>Person</th><th>Expires</th><th>Number</th><th>Details</th><th>Original is kept</th></tr></thead><tbody>
${rows}
</tbody></table>
${photos}${identity}</body></html>\n`;
}

const escHtml = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

/** "Home email", "Work phone", "Address": as the app names them. */
function contactLabel(label: string, noun: 'email' | 'phone' | 'address'): string {
  if (!label) return noun.charAt(0).toUpperCase() + noun.slice(1);
  return label.toLowerCase().includes(noun) ? label : `${label} ${noun}`;
}

/** "United Kingdom" for GB, where Node knows it; the code where it does not. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

const day = (d: unknown) =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? formatDate({ date: d, precision: 'day' })
    : null;

/**
 * One part of somebody's identity details, as lines of index.html: each
 * field the part has, in the catalogue's order, by its name.
 */
function identityLines(
  part: IdentityPartOut | null,
  onlyMe: boolean,
  exported: Map<string, string | null>,
): Array<{ label: string; html: string; onlyMe: boolean }> {
  if (!part) return [];
  const f = part.fields;
  const masked = new Set(part.masked ?? []);
  const out: Array<{ label: string; html: string; onlyMe: boolean }> = [];
  const add = (label: string, value: string) =>
    out.push({ label, html: escHtml(value).replace(/\n/g, '<br>'), onlyMe });
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  for (const field of IDENTITY_FIELDS) {
    const key = field.key;
    if (key === 'nationalities') {
      if (f.nationalities?.length) add(field.label, f.nationalities.map(countryName).join(', '));
      continue;
    }
    if ((IDENTITY_LISTS as readonly string[]).includes(key)) {
      for (const e of (f[key as IdentityList] ?? []) as unknown as Array<Record<string, unknown>>) {
        const hidden = masked.has(`${key}.${String(e.id)}`);
        if (key === 'emails' || key === 'phones') {
          if (text(e.value)) {
            add(contactLabel(text(e.label), key === 'emails' ? 'email' : 'phone'), text(e.value));
          }
        } else if (key === 'addresses') {
          const lines = [
            text(e.line1),
            text(e.line2),
            text(e.line3),
            [text(e.city), text(e.region), text(e.postal_code)].filter(Boolean).join(', '),
            text(e.country) ? countryName(text(e.country)) : '',
          ].filter(Boolean);
          if (lines.length) add(contactLabel(text(e.label), 'address'), lines.join('\n'));
        } else if (key === 'ids') {
          const kind = IDENTITY_ID_LABELS[e.kind as keyof typeof IDENTITY_ID_LABELS] ?? 'ID';
          const label = text(e.label) ? `${kind}: ${text(e.label)}` : kind;
          const parts = [
            hidden ? 'Number not in this export' : text(e.number) || null,
            text(e.issuer) ? `Issued by ${text(e.issuer)}` : null,
            day(e.issued_on) ? `Issued ${day(e.issued_on)}` : null,
            day(e.expires_on) ? `Expires ${day(e.expires_on)}` : null,
          ].filter((x): x is string => x !== null);
          const file = typeof e.document_id === 'string' ? exported.get(e.document_id) : null;
          out.push({
            label,
            html:
              parts.map(escHtml).join('<br>') +
              (file
                ? `${parts.length ? '<br>' : ''}<a href="${escHtml(file)}">The document</a>`
                : ''),
            onlyMe,
          });
        } else if (key === 'custom') {
          if (hidden) add(text(e.label) || 'Detail', 'Not in this export');
          else if (text(e.value)) add(text(e.label) || 'Detail', text(e.value));
        }
      }
      continue;
    }
    const v = text(f[key as keyof IdentityFields]);
    if (!v) continue;
    add(field.label, key === 'country_of_birth' ? countryName(v) : v);
  }
  return out;
}

/**
 * What the requester may have of the people (5.27), read as the vault
 * itself: whose identity details they may read now — canSeeIdentity, under
 * the audience in effect, the database's own identity_audience_now() — each
 * part opened; and whose photo they may see (A68: the roles of
 * family.details, or their own).
 */
async function peopleFor(
  deps: ExportDeps,
  trx: Db,
  hh: string,
  requester: { member_id: string; role: Parameters<typeof can>[0] },
  members: ReadonlyArray<{ id: string }>,
): Promise<{
  identities: Map<string, Partial<Record<IdentityPart, IdentityFields>>>;
  photos: Map<string, Buffer>;
}> {
  const viewer = { role: requester.role, memberId: requester.member_id };
  const audience =
    (await sql<{ a: string | null }>`select identity_audience_now() as a`.execute(trx)).rows[0]
      ?.a ?? 'owners_and_self';
  const readable = members.filter((m) => canSeeIdentity(viewer, m, audience)).map((m) => m.id);
  const rows = readable.length
    ? await trx
        .selectFrom('member_identity')
        .selectAll()
        .where('member_id', 'in', readable)
        .execute()
    : [];
  const identities = new Map<string, Partial<Record<IdentityPart, IdentityFields>>>();
  for (const r of rows) {
    // Another person's Only me part is in nobody's export but theirs.
    if (!canSeeIdentity(viewer, { id: r.member_id }, audience, r.part)) continue;
    const key = await deps.keys.unwrapById(trx, r.wrapped_by_scope);
    const fields = openIdentity(key, { householdId: hh, memberId: r.member_id, part: r.part }, r);
    identities.set(r.member_id, {
      ...identities.get(r.member_id),
      [r.part]: fields as IdentityFields,
    });
  }
  const photos = new Map<string, Buffer>();
  const family = can(requester.role, 'family.details');
  const ready = await trx
    .selectFrom('member_photo')
    .select(['id', 'member_id', 'sealed'])
    .where('state', '=', 'ready')
    .execute();
  const mayHave = ready.filter(
    (p) => p.sealed !== null && (family || p.member_id === requester.member_id),
  );
  if (mayHave.length > 0) {
    const scope = await deps.keys.unwrap(trx, { householdId: hh, kind: 'household' });
    for (const p of mayHave) {
      try {
        photos.set(
          p.member_id,
          openBytes(scope.key, p.sealed as Buffer, memberPhotoBinding(hh, p.member_id, p.id)),
        );
      } catch {
        // A seal that does not open is that photo's, not the export's: the
        // person is listed without it, as the app shows their initials.
        deps.log('warn', 'photo_unreadable', { member_id: p.member_id });
      }
    }
  }
  return { identities, photos };
}

/**
 * A person's identity details as their export file has them (5.27): the
 * requester's own whole, both parts; anybody else's shared part as the app
 * shows it, masked. A document an ID is on stays named only where the
 * requester may see that document. Null when there is nothing to say.
 */
export function identityRecord(
  person: { id: string; display_name: string },
  parts: Partial<Record<IdentityPart, IdentityFields>> | undefined,
  requesterMember: string,
  maySeeDocument: (id: string) => boolean,
): IdentityRecordOut | null {
  if (!parts) return null;
  const own = person.id === requesterMember;
  const shown = (fields: IdentityFields | undefined): IdentityPartOut | null => {
    if (!fields || identityFilled(fields).length === 0) return null;
    const linked: IdentityFields = fields.ids
      ? {
          ...fields,
          ids: fields.ids.map((i) => {
            if (!i.document_id || maySeeDocument(i.document_id)) return i;
            const unlinked = { ...i };
            delete unlinked.document_id;
            return unlinked;
          }),
        }
      : fields;
    if (own) return { fields: linked };
    const masked = maskIdentity(linked);
    return masked.masked.length
      ? { fields: masked.fields, masked: masked.masked }
      : { fields: masked.fields };
  };
  const shared = shown(parts.shared);
  const onlyMe = own ? shown(parts.only_me) : null;
  if (!shared && !onlyMe) return null;
  return {
    person: person.display_name,
    member_id: person.id,
    shared,
    ...(onlyMe ? { only_me: onlyMe } : {}),
  };
}

const README = `This folder is a complete export from Family Document Vault.

- Each file is the original as it was uploaded, in a folder named after its category.
- index.html opens in any browser and lists every document with its details.
- index.csv is the same list for a spreadsheet; index.json is the same list for software.
- A document listed with no file says why (file_note): its file was removed for good.
- people/ holds each person's photo you can see; identity/ holds the identity details
  you can see, a file for each person. Yours are all there, Only me included; other
  people's ID numbers and hidden details are not: the vault shows those only when you
  confirm it's you.
- Nothing here depends on the vault software. Keep it somewhere safe.
`;
