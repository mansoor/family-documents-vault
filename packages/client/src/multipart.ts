import type { CaptureMetadata, PhotoCrop } from '@fdv/shared';
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

/**
 * A multipart boundary nobody can guess (the D1 review): one a file's bytes
 * could hold by chance or design would cut the file short. From Web
 * Crypto's random numbers, which every platform this runs on has.
 */
export function newBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `fdv-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function multipartBody(
  parts: Array<FieldPart | FilePart>,
  boundary = newBoundary(),
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

/** A person's photo (0.5.19): the picture, and the part of it to show — none for the middle. */
export interface PhotoBody {
  file: CaptureFile;
  crop?: PhotoCrop | null;
}

/**
 * The body PUT /members/{id}/photo takes: the crop first, as a `crop`
 * field (JSON), then the picture as `file`, and nothing else. The vault
 * refuses any other order, and keeps nothing of it.
 */
export function photoUpload(body: PhotoBody): UploadBody {
  const crop = body.crop ? JSON.stringify(body.crop) : null;
  if (body.file.kind === 'bytes') {
    const m = multipartBody([
      ...(crop ? [{ name: 'crop', value: crop }] : []),
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
  if (!FormDataCtor) throw new Error('No FormData on this platform: send the photo as bytes.');
  const form = new FormDataCtor();
  if (crop) form.append('crop', crop);
  form.append('file', body.file.blob, body.file.filename);
  return { kind: 'form', form };
}

/**
 * The body POST /batches/{id}/items takes (Phase 6, I1): the file as
 * `file`; and, before it, where it was under the folder chosen
 * (`relative_path`, 0.8.0, S2) — only to a vault with
 * `features.folder_suggestions`, as an older one refuses the field.
 */
export function batchItemUpload(file: CaptureFile, relativePath?: string | null): UploadBody {
  if (file.kind === 'bytes') {
    const m = multipartBody([
      ...(relativePath ? [{ name: 'relative_path', value: relativePath }] : []),
      { name: 'file', filename: file.filename, contentType: file.contentType, bytes: file.bytes },
    ]);
    return { kind: 'bytes', bytes: m.bytes, contentType: m.contentType };
  }
  const FormDataCtor = (globalThis as { FormData?: new () => FormDataLike }).FormData;
  if (!FormDataCtor) throw new Error('No FormData on this platform: send the file as bytes.');
  const form = new FormDataCtor();
  if (relativePath) form.append('relative_path', relativePath);
  form.append('file', file.blob, file.filename);
  return { kind: 'form', form };
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

/** As much of a ReadableStream as a computer's upload needs, with no platform's types. */
export interface ReadableStreamLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
  };
}

/**
 * A file a computer sends (0.8.0, D1): bytes it holds, a platform file
 * object (a webview's File or Blob, or Node's `fs.openAsBlob`), or a stream
 * of bytes read as they are sent (Node's `fs.createReadStream`, or a
 * ReadableStream) — never the whole file in memory but for `bytes`.
 */
export type DeviceFile =
  | CaptureFile
  | {
      kind: 'stream';
      filename: string;
      contentType: string;
      /** An async iterable of chunks, or anything with `getReader()` (a ReadableStream). */
      stream: AsyncIterable<Uint8Array> | ReadableStreamLike;
    };

/**
 * The body POST /device-uploads takes: an optional `relative_path` field
 * first, then the file as `file`, and nothing else.
 */
export function deviceUploadBody(file: DeviceFile, relativePath?: string): UploadBody {
  const fields: FieldPart[] = relativePath ? [{ name: 'relative_path', value: relativePath }] : [];
  if (file.kind === 'bytes') {
    const m = multipartBody([
      ...fields,
      { name: 'file', filename: file.filename, contentType: file.contentType, bytes: file.bytes },
    ]);
    return { kind: 'bytes', bytes: m.bytes, contentType: m.contentType };
  }
  if (file.kind === 'stream') return streamedMultipart(fields, file);
  const FormDataCtor = (globalThis as { FormData?: new () => FormDataLike }).FormData;
  if (!FormDataCtor) throw new Error('No FormData on this platform: send the file as bytes.');
  const form = new FormDataCtor();
  if (relativePath) form.append('relative_path', relativePath);
  form.append('file', file.blob, file.filename);
  return { kind: 'form', form };
}

/** The platform's ReadableStream, as far as a streamed body needs it. */
type StreamCtor = new (source: {
  pull(controller: {
    enqueue(chunk: Uint8Array): void;
    close(): void;
    error(e: unknown): void;
  }): Promise<void>;
  cancel?(): Promise<void>;
}) => unknown;

/** A multipart body whose file part is read from a stream as it is sent. */
function streamedMultipart(
  fields: FieldPart[],
  file: {
    filename: string;
    contentType: string;
    stream: AsyncIterable<Uint8Array> | ReadableStreamLike;
  },
): UploadBody {
  const Stream = (globalThis as { ReadableStream?: StreamCtor }).ReadableStream;
  if (!Stream) throw new Error('No ReadableStream on this platform: send the file as a Blob.');
  const boundary = newBoundary();
  const enc = new TextEncoder();
  const head = enc.encode(
    fields
      .map(
        (f) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${quote(f.name)}"\r\n\r\n${f.value}\r\n`,
      )
      .join('') +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quote(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const source = file.stream;
  const chunks: AsyncIterator<Uint8Array> =
    'getReader' in source
      ? (() => {
          const reader = source.getReader();
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              const r = await reader.read();
              return r.done || !r.value
                ? { done: true, value: undefined }
                : { done: false, value: r.value };
            },
          };
        })()
      : source[Symbol.asyncIterator]();
  let stage: 'head' | 'file' | 'tail' | 'done' = 'head';
  const stream = new Stream({
    async pull(controller) {
      try {
        if (stage === 'head') {
          stage = 'file';
          controller.enqueue(head);
          return;
        }
        if (stage === 'file') {
          const next = await chunks.next();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          stage = 'tail';
        }
        if (stage === 'tail') {
          stage = 'done';
          controller.enqueue(tail);
          return;
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await chunks.return?.();
    },
  });
  return { kind: 'stream', stream, contentType: `multipart/form-data; boundary=${boundary}` };
}
