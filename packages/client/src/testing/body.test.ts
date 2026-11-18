import { describe, expect, it } from 'vitest';
import { createApi } from '../api.js';
import { createHttp } from '../http.js';
import { multipartBody } from '../multipart.js';
import { multipartParts, partsOf, readBody } from './body.js';
import { createFakeVault } from './fake.js';

/**
 * The fake vault reads an upload's bytes as they were sent (CL3): a file
 * of any bytes — every byte value, CRLF and dashes that look like a
 * boundary, sequences that are not UTF-8 — is stored, hashed and given
 * back exactly, whatever the client handed its fetch.
 */

const enc = new TextEncoder();

/** Every byte value twice, and a line that looks like a part's boundary and headers. */
function everyByte(): Uint8Array {
  const parts = [
    enc.encode('%PDF-1.4\n'),
    Uint8Array.from({ length: 512 }, (_, i) => i % 256),
    enc.encode('\r\n--fdv-00112233\r\nContent-Disposition: form-data; name="x"\r\n\r\n\r\n--\r\n'),
    new Uint8Array([0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0xbc, 0xff]),
    enc.encode('\n%%EOF\n'),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The platform's own classes, which this package's ES2022 types do not name. */
const platform = globalThis as unknown as {
  Blob: new (parts: unknown[], opts?: { type?: string }) => { size: number };
  File: new (parts: unknown[], name: string, opts?: { type?: string }) => { size: number };
  FormData: new () => { append(name: string, value: unknown, filename?: string): void };
  ReadableStream: new (source: {
    start(c: { enqueue(chunk: Uint8Array): void; close(): void }): void;
  }) => unknown;
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const own = new Uint8Array(bytes.length);
  own.set(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', own));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('the fake vault reads a multipart body in bytes (CL3)', () => {
  it('keeps a file of every byte value exactly, with fields before and after it as text', () => {
    const file = everyByte();
    const body = multipartBody(
      [
        { name: 'metadata', value: '{"title":"Café ✓"}' },
        { name: 'file', filename: 'every.pdf', contentType: 'application/pdf', bytes: file },
        { name: 'after', value: 'last' },
      ],
      'fdv-0011223344556677',
    );
    const parts = multipartParts(body.bytes, body.contentType);
    expect(parts.map((p) => p.name)).toEqual(['metadata', 'file', 'after']);
    expect(parts[0]?.value).toBe('{"title":"Café ✓"}');
    expect(parts[1]).toMatchObject({
      value: null,
      filename: 'every.pdf',
      type: 'application/pdf',
      size: file.length,
    });
    expect(parts[1]?.bytes).toEqual(file);
    expect(parts[2]?.value).toBe('last');
  });

  it('finds the boundary on the first line without a content type, and quoted in one', () => {
    const file = everyByte();
    const body = multipartBody([
      { name: 'file', filename: 'a.bin', contentType: 'image/png', bytes: file },
    ]);
    expect(partsOf(body.bytes)?.[0]?.bytes).toEqual(file);
    const boundary = /boundary=(.+)$/.exec(body.contentType)?.[1] as string;
    const quoted = `multipart/form-data; boundary="${boundary}"`;
    expect(multipartParts(body.bytes, quoted)[0]?.bytes).toEqual(file);
  });

  it('reads a stream, an async iterable, an ArrayBuffer and a Blob into the bytes sent', async () => {
    const file = everyByte();
    const halves = [file.slice(0, 300), file.slice(300)];
    const stream = new platform.ReadableStream({
      start(c) {
        for (const h of halves) c.enqueue(h);
        c.close();
      },
    });
    expect(await readBody(stream)).toEqual(file);
    async function* chunks() {
      yield* halves;
    }
    expect(await readBody(chunks())).toEqual(file);
    expect(await readBody(file.slice().buffer)).toEqual(file);
    // A view of part of a buffer: its own bytes, not the buffer's.
    const wide = new Uint8Array(file.length + 8);
    wide.set(file, 4);
    expect(await readBody(new DataView(wide.buffer, 4, file.length))).toEqual(file);
    expect(await readBody(new platform.Blob([file]))).toEqual(file);
    expect(await readBody('{"a":1}')).toBe('{"a":1}');
  });

  it('reads a platform FormData’s File for its bytes', async () => {
    const file = everyByte();
    const form = new platform.FormData();
    form.append('metadata', '{}');
    form.append('file', new platform.File([file], 'every.pdf', { type: 'application/pdf' }));
    expect(await readBody(form)).toBe(form);
    const parts = partsOf(form);
    expect(parts?.map((p) => [p.name, p.value === null])).toEqual([
      ['metadata', false],
      ['file', true],
    ]);
    expect(parts?.[1]).toMatchObject({ filename: 'every.pdf', size: file.length });
    expect(parts?.[1]?.bytes).toEqual(file);
  });
});

describe('the fake vault stores and gives back the bytes uploaded (CL3)', () => {
  const setUp = async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const t = await api.setup({
      household_name: 'The fake family',
      display_name: 'Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    return { vault, api, token: t.access_token };
  };
  const content = async (api: ReturnType<typeof createApi>, token: string, versionId: string) => {
    const res = await api.content(token, versionId);
    expect(res.status).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  };

  it('a capture sent as a platform FormData: its version’s content is the File’s bytes', async () => {
    const { api, token } = await setUp();
    const file = everyByte();
    const form = new platform.FormData();
    form.append('file', new platform.File([file], 'every.pdf', { type: 'application/pdf' }));
    const made = await api.capture(
      token,
      { kind: 'form', form },
      '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b',
    );
    const got = await content(api, token, made.version_id);
    expect(await sha256(got)).toBe(await sha256(file));
    expect(got).toEqual(file);
    const res = await api.content(token, made.version_id);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename\*=UTF-8''every\.pdf$/,
    );
    // A version nobody made is not there.
    await expect(api.content(token, 'version-none')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('a computer’s file sent as a stream: the item’s size is exact, and accepted, its bytes', async () => {
    const { api, token } = await setUp();
    const pairing = await api.createDevicePairing(token);
    const paired = await api.pairDevice({
      code: pairing.code,
      device_name: 'Laptop',
      platform: 'windows',
    });
    const device = { device_id: paired.device_id, key: paired.key };
    const file = everyByte();
    async function* chunks() {
      yield file.slice(0, 100);
      yield file.slice(100);
    }
    const sent = await api.deviceUpload(
      device,
      { kind: 'stream', filename: 'every.pdf', contentType: 'application/pdf', stream: chunks() },
      '1c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c',
    );
    const batch = (await api.batches(token)).items[0];
    const item = (await api.batch(token, batch?.id as string)).items.find(
      (i) => i.id === sent.item_id,
    );
    expect(item?.byte_size).toBe(file.length);
    const done = await api.acceptBatchItem(token, batch?.id as string, sent.item_id, {});
    expect(await content(api, token, done.version_id)).toEqual(file);
  });

  it('a capture and a new version sent as bytes: each version’s content is what was sent', async () => {
    const { api, token } = await setUp();
    const file = everyByte();
    const form = multipartBody([
      { name: 'file', filename: 'every.pdf', contentType: 'application/pdf', bytes: file },
    ]);
    const made = await api.capture(
      token,
      { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
      '2d3e4f50-6172-4839-8cbd-2e3f4a5b6c7d',
    );
    const version = multipartBody([
      { name: 'file', filename: 'again.png', contentType: 'image/png', bytes: file },
    ]);
    const added = await api.upload(
      token,
      made.document_id,
      { kind: 'bytes', bytes: version.bytes, contentType: version.contentType },
      '3e4f5061-7283-494a-9dce-3f4a5b6c7d8e',
    );
    expect(added).toMatchObject({ byte_size: file.length, mime: 'image/png' });
    expect(await content(api, token, made.version_id)).toEqual(file);
    expect(await content(api, token, added.id)).toEqual(file);
  });
});
