import { UPLOAD_KINDS } from './wire.js';

/**
 * Health records stored as they are (0.9.0, H5): the files a patient
 * portal or a hospital hands out besides its PDF — a C-CDA document (XML),
 * a FHIR export (JSON), a DICOM image, and a ZIP of a DICOM folder or a
 * portal's whole export.
 *
 * The vault keeps them sealed like any file and never opens them: no
 * reading, no OCR, no AI, no pages drawn, no thumbnail, and never unzipped.
 * They are downloaded only, always as an attachment, XML and JSON under a
 * type no browser renders. What a file is is checked, not trusted: DICOM
 * by `DICM` at byte 128, a ZIP by its `PK` signature, and XML and JSON as
 * UTF-8 text that starts as they do — never parsed further. The size limit
 * is the vault's own (FDV_MAX_UPLOAD_BYTES).
 *
 * Taken by a single add, a new version and a batch's item a person adds
 * (`features.record_formats`); never by the scanner folder, email in or a
 * computer's key, which take scans, nor by a request's link.
 */

export const XML_MIME = 'application/xml';
export const JSON_MIME = 'application/json';
export const DICOM_MIME = 'application/dicom';
export const ZIP_MIME = 'application/zip';

/** The record formats, each as it is stored and the extension it is stored under. */
export const RECORD_KINDS: Readonly<Record<string, string>> = {
  [XML_MIME]: 'xml',
  [JSON_MIME]: 'json',
  [DICOM_MIME]: 'dcm',
  [ZIP_MIME]: 'zip',
};

/** What a single add, a new version and a person's batch item keep: the usual kinds, and records. */
export const STORED_KINDS: Readonly<Record<string, string>> = { ...UPLOAD_KINDS, ...RECORD_KINDS };

/** For a file picker's `accept`: the record formats, by their endings. */
export const RECORD_ACCEPT = '.xml,.json,.dcm,.zip';

/** Whether a file is a health record stored as it is: never read, drawn or opened by the vault. */
export function isRecordFormat(mime: string | null | undefined): boolean {
  return typeof mime === 'string' && mime in RECORD_KINDS;
}

/** The types a browser or an app says a record file is, each to the type it is kept as. */
const DECLARED: Readonly<Record<string, string>> = {
  'application/xml': XML_MIME,
  'text/xml': XML_MIME,
  'application/json': JSON_MIME,
  'application/fhir+json': JSON_MIME,
  'text/json': JSON_MIME,
  'application/dicom': DICOM_MIME,
  'application/zip': ZIP_MIME,
  'application/x-zip-compressed': ZIP_MIME,
  'application/x-zip': ZIP_MIME,
};

/** The endings a record file has, each to the type it is kept as. */
const ENDINGS: Readonly<Record<string, string>> = {
  xml: XML_MIME,
  json: JSON_MIME,
  dcm: DICOM_MIME,
  dicom: DICOM_MIME,
  zip: ZIP_MIME,
};

/**
 * What says nothing of a file: the name decides then. `text/plain` too: a
 * browser or a system may send a `.json` or an `.xml` as plain text.
 */
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'text/plain']);

/** A type as sent, without its parameters, in lower case. */
const baseType = (declared: string) => (declared.split(';')[0] ?? '').trim().toLowerCase();

/** Whether the type a file was sent with says nothing of what it is. */
export function saysNothing(declared: string): boolean {
  return GENERIC.has(baseType(declared));
}

/**
 * Which record format a file says it is, from the type it was sent with
 * and, when that says nothing, its name; or null. Only a claim: the bytes
 * must bear it out (the API's sniffStream). A file sent as a PDF, a photo
 * or an Office file is never taken for a record, whatever its name. An
 * ending the vault doesn't keep (`.ndjson`, say) is no claim.
 */
export function claimedRecordFormat(declared: string, filename: string): string | null {
  const type = baseType(declared);
  const byType = DECLARED[type];
  if (byType) return byType;
  if (!GENERIC.has(type)) return null;
  const ending = /\.([a-z0-9]{1,8})$/i.exec(filename.trim())?.[1]?.toLowerCase() ?? '';
  return ENDINGS[ending] ?? null;
}

/**
 * A record known by its bytes alone (the review of H5): a file whose type
 * and name say nothing — a hospital CD's `IM00001` — that file-type finds
 * to be a DICOM image or a plain ZIP. Never one sent as anything else.
 */
export function recordByBytes(declared: string, found: string | undefined): string | null {
  if (!GENERIC.has(baseType(declared))) return null;
  return found === DICOM_MIME || found === ZIP_MIME ? found : null;
}

/**
 * The name a record is kept and downloaded under: its own, ending as what
 * it is (`.xml`, `.json`, `.dcm`, `.zip`) — so an `invoice.html` kept as
 * XML is `invoice.xml`, and `IM00001` is `IM00001.dcm`. Any other file's
 * name is as it was.
 */
export function recordFileName(filename: string, mime: string): string {
  const ext = RECORD_KINDS[mime];
  if (!ext) return filename;
  const base = filename.replace(/\.[^./\\]{1,10}$/, '').trim() || 'record';
  return `${base}.${ext}`;
}

/**
 * The Content-Type a file is sent with: its own, but for XML and JSON,
 * which a browser would render (and run a script in, for XML) — those go
 * as `application/octet-stream`, always an attachment, never sniffed.
 */
export function deliveredType(mime: string): string {
  return mime === XML_MIME || mime === JSON_MIME ? 'application/octet-stream' : mime;
}

/** A record format in words: "an XML file (such as C-CDA)". */
export function recordFormatWords(mime: string | null | undefined): string {
  switch (mime) {
    case XML_MIME:
      return 'an XML file (such as C-CDA)';
    case JSON_MIME:
      return 'a JSON file (such as FHIR)';
    case DICOM_MIME:
      return 'a DICOM image';
    case ZIP_MIME:
      return 'a ZIP file';
    default:
      return 'a file the vault doesn’t open';
  }
}

/** Short, for a list: XML, JSON, DICOM, ZIP. */
export function recordFormatLabel(mime: string | null | undefined): string | null {
  switch (mime) {
    case XML_MIME:
      return 'XML';
    case JSON_MIME:
      return 'JSON';
    case DICOM_MIME:
      return 'DICOM';
    case ZIP_MIME:
      return 'ZIP';
    default:
      return null;
  }
}

/** Said where a record file's pages would be: no preview, and what to do instead. */
export function recordNoPreviewWords(mime: string | null | undefined): string {
  return `No preview. This is ${recordFormatWords(mime)}, kept as it is: the vault doesn’t open, read or draw it. Download it to open it in the program it’s for. Your patient portal’s PDF is the readable copy.`;
}

/** Said where files are added: what record files are, in one line. */
export const RECORD_FORMATS_NOTE =
  'Health records from a patient portal — XML (C-CDA), JSON (FHIR), DICOM images, or a ZIP of them — are kept as they are and only downloaded: the vault doesn’t open them. Keep the portal’s PDF too; it’s the readable copy.';

/** `415 unsupported_type` for a record file whose bytes don't bear out what it says it is. */
export function recordRefusedWords(mime: string): string {
  switch (mime) {
    case XML_MIME:
    case JSON_MIME:
      return `That doesn’t look like ${recordFormatWords(mime)}: the vault keeps XML and JSON only as UTF-8 text. Export it again from the portal, or add its PDF.`;
    case DICOM_MIME:
      return 'That doesn’t look like a DICOM image: the vault looks for “DICM” at the start of the file. Put older images in a ZIP and add that.';
    default:
      return 'That doesn’t look like a ZIP file. Make the ZIP again and add it.';
  }
}

/**
 * Why a link to view can't give a file (`422 view_not_possible`): only the
 * pages the vault draws are shown, and it draws PDFs and photos alone.
 */
export function viewNotPossibleWords(mime: string | null | undefined): string {
  return isRecordFormat(mime)
    ? 'Health record files kept as they are can only be shared to download: the vault doesn’t open them, so it has no pages to show.'
    : 'Word and Excel files can only be shared to download: the vault cannot draw their pages.';
}

/** The kind of file a link to view can't give, in words, for a list's refusal. */
export function downloadOnlyKind(mime: string | null | undefined): string {
  return isRecordFormat(mime) ? 'Health record files kept as they are' : 'Word and Excel files';
}
