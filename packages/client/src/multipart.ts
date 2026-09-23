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
