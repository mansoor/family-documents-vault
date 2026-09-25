import type { CaptureMetadata } from '@fdv/shared';
import type { FormDataLike, UploadBody } from './http.js';

/**
 * A multipart/form-data body built from bytes, for callers that hold the
 * file themselves rather than a platform FormData: a capture queue that
 * kept the PDF, a test, a script. The server reads it exactly as it reads
 * a browser's form.
 */

export interface FieldPart {
  name: string;
  value: string;
}

export interface FilePart {
  name: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export function multipartBody(
  parts: Array<FieldPart | FilePart>,
  boundary = `fdv-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
): { bytes: Uint8Array; contentType: string } {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(part.name)}"`;
    if ('bytes' in part) {
      head += `; filename="${quote(part.filename)}"\r\nContent-Type: ${part.contentType}\r\n\r\n`;
      chunks.push(enc.encode(head), part.bytes, enc.encode('\r\n'));
    } else {
      chunks.push(enc.encode(`${head}\r\n\r\n${part.value}\r\n`));
    }
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Quotes and line breaks cannot appear inside a quoted header value. */
function quote(s: string): string {
  return s.replace(/["\r\n]/g, (c) => (c === '"' ? '%22' : ' '));
}

/**
 * One file for a capture: bytes (the phone's PDF), or a platform file object
 * — a browser's File or Blob, or React Native's `{ uri, name, type }`, which
 * carries its own name (RN's FormData ignores the third argument).
 */
export type CaptureFile =
  | { kind: 'bytes'; filename: string; contentType: string; bytes: Uint8Array }
  | { kind: 'blob'; filename: string; blob: unknown };

/** A capture: the file, and the card's details to send ahead of it. */
export interface CaptureBody {
  file: CaptureFile;
  metadata?: CaptureMetadata;
}

/**
 * The body POST /capture takes: the details first, as a `metadata` field,
 * then the file (0.4.9). A vault older than 0.4.9 would ignore the details,
 * so send them only when it has `features.capture_metadata`.
 */
export function captureUpload(body: CaptureBody): UploadBody {
  const meta = body.metadata ? JSON.stringify(body.metadata) : null;
  if (body.file.kind === 'bytes') {
    const m = multipartBody([
      ...(meta ? [{ name: 'metadata', value: meta }] : []),
      {
        name: 'file',
        filename: body.file.filename,
        contentType: body.file.contentType,
        bytes: body.file.bytes,
      },
    ]);
    return { kind: 'bytes', bytes: m.bytes, contentType: m.contentType };
  }
  const FormDataCtor = (globalThis as { FormData?: new () => FormDataLike }).FormData;
  if (!FormDataCtor) throw new Error('No FormData on this platform: send the file as bytes.');
  const form = new FormDataCtor();
  if (meta) form.append('metadata', meta);
  form.append('file', body.file.blob, body.file.filename);
  return { kind: 'form', form };
}
