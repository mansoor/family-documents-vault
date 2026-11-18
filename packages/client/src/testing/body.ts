/**
 * The fake vault's reading of a request body (CL3): bytes as they were
 * sent, whatever the client handed its fetch — bytes, a stream, a Blob or
 * a platform FormData — and a multipart body split into its parts on the
 * boundary in bytes. Only a part's header lines are read as text; a file's
 * bytes are kept exactly as they came, so what the fake stores, hashes and
 * gives back is what was sent.
 */

/**
 * One part of a multipart body: a field's value, or a file (value null)
 * with its name, type, size and bytes.
 */
export interface Part {
  name: string;
  value: string | null;
  filename?: string;
  type?: string;
  size?: number;
  /** A file's bytes, exactly as sent (none for a platform file the fake could not read). */
  bytes?: Uint8Array;
}

/** A Blob or File, as far as the fake reads one. */
interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  name?: unknown;
  type?: unknown;
  size?: unknown;
}

const isBlob = (v: unknown): v is BlobLike =>
  typeof v === 'object' && v !== null && typeof (v as BlobLike).arrayBuffer === 'function';

/** A platform FormData's parts, read when its request arrives (its files' bytes are read then). */
const formParts = new WeakMap<object, Part[]>();

/** Bytes, joined. */
function joined(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A view's own bytes, copied: what it shows of its buffer and nothing else. */
const viewBytes = (v: ArrayBufferView): Uint8Array =>
  new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();

/**
 * A request's body as the fake reads it: bytes stay bytes; an ArrayBuffer,
 * another typed array, a stream (a ReadableStream or an async iterable of
 * chunks) or a Blob is read into bytes; a platform FormData stays itself,
 * its parts read now — a File's bytes included — for `partsOf`. A string
 * (JSON) and no body are left as they are.
 */
export async function readBody(body: unknown): Promise<unknown> {
  if (body === undefined || body === null || typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return viewBytes(body);
  const entries = (body as { entries?: () => Iterable<[string, unknown]> }).entries;
  if (typeof entries === 'function') {
    const parts: Part[] = [];
    for (const [name, value] of entries.call(body)) {
      if (typeof value === 'string') {
        parts.push({ name, value });
        continue;
      }
      // A platform File or Blob: what it says of itself, and its bytes when
      // it can give them (React Native's `{ uri, name, type }` cannot).
      const file = value as { name?: unknown; type?: unknown; size?: unknown } | null;
      const bytes = isBlob(value) ? new Uint8Array(await value.arrayBuffer()) : undefined;
      parts.push({
        name,
        value: null,
        filename: typeof file?.name === 'string' ? file.name : 'file',
        type: typeof file?.type === 'string' && file.type ? file.type : 'application/octet-stream',
        size: bytes ? bytes.length : typeof file?.size === 'number' ? file.size : 0,
        ...(bytes ? { bytes } : {}),
      });
    }
    formParts.set(body, parts);
    return body;
  }
  const reader = (
    body as { getReader?: () => { read(): Promise<{ done: boolean; value?: unknown }> } }
  ).getReader;
  if (typeof reader === 'function') {
    const r = reader.call(body);
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      if (value !== undefined) chunks.push(chunkBytes(value));
    }
    return joined(chunks);
  }
  const iterate = (body as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[
    Symbol.asyncIterator
  ];
  if (typeof iterate === 'function') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<unknown>) chunks.push(chunkBytes(chunk));
    return joined(chunks);
  }
  if (isBlob(body)) return new Uint8Array(await body.arrayBuffer());
  return body;
}

/** One chunk of a stream as bytes: Node's Buffers are Uint8Arrays; a string is UTF-8. */
function chunkBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return viewBytes(chunk);
  return new TextEncoder().encode(String(chunk));
}

/** Where `needle` first is in `hay`, from `from` on; -1 if nowhere. */
function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  const last = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let k = 1; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

const CRLF = new Uint8Array([13, 10]);
const HEADERS_END = new Uint8Array([13, 10, 13, 10]);

/** The boundary a multipart body's content type names, or its first line's. */
function boundaryOf(body: Uint8Array, contentType: string | undefined): string | null {
  const said = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  if (said) return (said[1] ?? said[2]) as string;
  // No content type (a test's bare bytes): the first line is `--boundary`.
  const end = indexOf(body, CRLF, 0);
  if (end < 3 || body[0] !== 45 || body[1] !== 45) return null;
  return new TextDecoder().decode(body.subarray(2, end));
}

/**
 * A multipart/form-data body's parts, in order, split on the boundary in
 * bytes (RFC 7578, RFC 2046 §5.1.1): each delimiter is CRLF, `--` and the
 * boundary, so CRLF and dashes inside a file are only bytes. A part's
 * header lines are read as text; a field's value as UTF-8; a file's bytes
 * are kept as they are. Anything malformed ends the reading there.
 */
export function multipartParts(body: Uint8Array, contentType?: string): Part[] {
  const boundary = boundaryOf(body, contentType);
  if (!boundary) return [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const opening = enc.encode(`--${boundary}`);
  const delimiter = enc.encode(`\r\n--${boundary}`);
  let at: number;
  if (indexOf(body.subarray(0, opening.length), opening, 0) === 0) at = opening.length;
  else {
    // A preamble before the first delimiter is ignored, as RFC 2046 says.
    const first = indexOf(body, delimiter, 0);
    if (first < 0) return [];
    at = first + delimiter.length;
  }
  const out: Part[] = [];
  for (;;) {
    // `--` after a delimiter closes the body.
    if (body[at] === 45 && body[at + 1] === 45) break;
    const lineEnd = indexOf(body, CRLF, at);
    if (lineEnd < 0) break;
    // The rest of the delimiter's line is transport padding (spaces, tabs).
    const headStart = lineEnd + 2;
    const empty = body[headStart] === 13 && body[headStart + 1] === 10;
    const headEnd = empty ? headStart : indexOf(body, HEADERS_END, headStart);
    if (headEnd < 0) break;
    const head = dec.decode(body.subarray(headStart, headEnd));
    const contentStart = headEnd + (empty ? 2 : 4);
    const next = indexOf(body, delimiter, contentStart);
    if (next < 0) break;
    const content = body.slice(contentStart, next);
    at = next + delimiter.length;
    const disposition = /^content-disposition:([^\r\n]*)/im.exec(head)?.[1] ?? '';
    const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) continue;
    const filename = /;\s*filename="([^"]*)"/i.exec(disposition)?.[1];
    if (filename === undefined) {
      out.push({ name, value: dec.decode(content) });
      continue;
    }
    out.push({
      name,
      value: null,
      filename,
      type: /^content-type:([^\r\n]*)/im.exec(head)?.[1]?.trim() || 'application/octet-stream',
      size: content.length,
      bytes: content,
    });
  }
  return out;
}

/**
 * The parts of an upload's body, in order — its fields, and whether each
 * came before the file — from bytes (`multipartParts`) or a platform
 * FormData `readBody` has read; null for anything else.
 */
export function partsOf(body: unknown, contentType?: string): Part[] | null {
  if (body instanceof Uint8Array) return multipartParts(body, contentType);
  if (typeof body === 'object' && body !== null) {
    const read = formParts.get(body);
    if (read) return read;
  }
  return null;
}
