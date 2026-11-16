/**
 * Several documents downloaded as one ZIP (0.9.0, DL; FND-05): ticked rows
 * of the Documents table, a whole collection, or what a share link gives —
 * each file as its single download gives it, with a readable index
 * (index.html and index.csv).
 *
 * `POST /documents/download` `{ document_ids }` and `POST
 * /collections/{id}/download` (signed in), and `GET /shared/items/download`
 * (`?ids=a,b` for some of them; inside a link to download's session) answer
 * `application/zip`, streamed. Each document goes in only if the caller
 * could download it on its own; one they can see but not download (no file,
 * a file removed for good) is named in the index, and one they cannot see
 * is simply not there. A note goes in as its words, a Markdown file (`.md`,
 * as the full export writes it) — `GET /shared/items/{id}/note/download`
 * gives one on its own. A selection or collection with a Sensitive document
 * in it asks to confirm it's you first (`403 step_up_required`, action
 * `download_sensitive`); one with an Only me or an Essential document asks
 * what opening it asks. More than `ZIP_MAX_DOCUMENTS` files, or
 * `ZIP_MAX_BYTES` in all, is `422 zip_too_large`; nothing with a file is
 * `422 nothing_to_zip`. Absent from older vaults (`features.zip_download`).
 */

/** The most files one ZIP holds: past this, Settings → Export takes everything. */
export const ZIP_MAX_DOCUMENTS = 200;
/** The most bytes of files one ZIP holds (1 GB), before it is made. */
export const ZIP_MAX_BYTES = 1024 * 1024 * 1024;

/** `POST /documents/download`: the ticked rows, in the order shown. */
export interface ZipSelectionInput {
  document_ids: string[];
}

/**
 * `POST /documents/download/ticket` and `POST /collections/{id}/download/ticket`
 * (DL review): where the ZIP is, for a browser to follow as a plain link —
 * once, before `expires_at` (a minute).
 */
export interface ZipTicket {
  url: string;
  expires_at: string;
}

/** `GET /shared/items/download/check` (DL review): a ZIP of them would be given; how many. */
export interface ZipCheck {
  ok: true;
  documents: number;
}

/** Why a document the caller can see is not in the ZIP, as the index says it. */
export const ZIP_LEFT_OUT = {
  /** A document with no file kept, only its details. */
  no_file: 'Not included: it has no file, only its details.',
  /** A note whose words only its owner may open (an Only me one): they stay in the vault. */
  note: 'Not included: only its owner can open this note’s words.',
  /** Its record came back with a restore, its file did not (5.24). */
  removed: 'Not included: its file was removed for good.',
  /**
   * Its file was not where the files are kept as the ZIP was made (the full
   * export's FILE_NOT_THERE): left out, and the rest go on.
   */
  not_there: 'Not included: its file was not where your files are kept when this was made.',
  /** A link's downloads used up part-way through (5.18). */
  used_up: 'Not included: this link has been downloaded from as many times as it allows.',
} as const;
export type ZipLeftOut = keyof typeof ZIP_LEFT_OUT;

/** The words of `422 zip_too_large`: where everything can be had instead, for whoever may export. */
export function zipTooLarge(mayExport: boolean): string {
  const most = `${ZIP_MAX_DOCUMENTS} documents or ${Math.round(ZIP_MAX_BYTES / 1024 ** 3)} GB`;
  return mayExport
    ? `That is more than one download holds (${most}). To download everything, use Settings → Export.`
    : `That is more than one download holds (${most}). Choose fewer documents.`;
}

/** The ZIP's own name, as the browser saves it: "Family documents 2026-11-15.zip". */
export function zipFileName(name: string | null, today: string): string {
  const base = name ? safeFileName(name) : 'Family documents';
  return `${base} ${today}.zip`;
}

/** Names Windows keeps for devices: never a file's name, whatever follows the dot. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A file's name as a ZIP may hold it anywhere (the full export's rule, 5.x,
 * since DL also the selection's): in NFC, letters and digits of any script
 * (with their marks), `_`, `.`, `'`, `-` and spaces kept; control and
 * formatting characters — a right-to-left override among them — taken
 * out; anything else — a slash, a colon, `..` as a path — made `_`; at most
 * 80 characters; never empty, never a name Windows keeps for a device, and
 * never ending in a dot or a space, which Windows drops.
 */
export function safeFileName(s: string): string {
  const kept = s
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}_.'\- ]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  // By characters, never half of one.
  let out = Array.from(kept)
    .slice(0, 80)
    .join('')
    .replace(/[. ]+$/, '');
  // Nothing but dots is a path, not a name.
  if (/^\.*$/.test(out)) out = '';
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  return out || 'untitled';
}

/**
 * A file's extension, as it may go on a name in the ZIP: a dot and up to
 * eight letters or digits, lower case; else none.
 */
export function safeExtension(filename: string): string {
  return (/\.[A-Za-z0-9]{1,8}$/.exec(filename)?.[0] ?? '').toLowerCase();
}

/** The index's own files: never a document's name. */
export const ZIP_INDEX_FILES = ['index.html', 'index.csv'] as const;

/**
 * Names in a ZIP, each once: "Passport.pdf", then "Passport (2).pdf" —
 * told apart whatever their case, as Windows and macOS tell names apart.
 * The index's files are taken from the start: a document called "index"
 * with a CSV is "index (2).csv".
 */
export function zipNames(): (base: string, ext: string) => string {
  const used = new Set<string>(ZIP_INDEX_FILES);
  return (base, ext) => {
    let name = `${base}${ext}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
}

/**
 * One cell of an index.csv (the full export's rule): text a spreadsheet
 * would run as a formula — from =, +, -, @, a tab or a carriage return on —
 * gets an apostrophe in front, so it is shown as the text it is.
 */
export function csvCell(v: string | number | readonly string[] | null | undefined): string {
  let s = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A note's Markdown as a file any Markdown viewer may open (the N1 review):
 * what would read there as HTML — `<` before a letter, `/`, `!` or `?`,
 * and `&` before what reads as an entity — is written with a backslash,
 * which such a viewer shows as the character, and a person reads past. The
 * rest is the note as it was written.
 *
 * Backslashes the note already has just before a `<` or an `&` are doubled
 * first (the N1 re-check): a viewer reads each pair as one backslash, so
 * none of them can take the escape added after them for itself — `\<img>`
 * stays the text `\<img>`, never a backslash and then HTML.
 */
export function markdownText(md: string): string {
  return md
    .replace(/\\+(?=[<&])/g, (run) => run + run)
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
}

/**
 * A note as a file (0.9.0, DL): Markdown, `.md`, as the full export writes
 * it — its title as a heading, then its words, safe for any viewer.
 */
export function noteMarkdown(title: string | null, words: string | null): string {
  return markdownText(`${title ? `# ${title}\n\n` : ''}${words ?? ''}\n`);
}

/**
 * A file's name in a Content-Disposition, by RFC 5987 (`filename*`): what
 * encodeURIComponent leaves, but `'`, `(`, `)` and `*` too, which that
 * grammar does not allow bare.
 */
export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `attachment; filename*=UTF-8''…`: a download, named by RFC 5987. */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${rfc5987(filename)}`;
}
