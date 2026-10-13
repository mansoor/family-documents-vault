import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApi, createHttp } from '@fdv/client';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * `@fdv/client`'s device paths under Node's own fetch, against the API
 * listening on a port (0.8.0, D1): what the uploader app runs on — a file
 * as bytes, as a Blob (`fs.openAsBlob`, read as it is sent), and as a
 * stream (an async iterable, and a ReadableStream) sent half-duplex. No
 * browser API, no inject: the bytes that arrive are the bytes sent.
 */

const PDF = Buffer.from(
  `%PDF-1.4\n% ${'client stream '.repeat(4000)}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
);

describe.skipIf(!testAdminUrl())('the client’s device paths, under plain fetch (0.8.0, D1)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let dir: string;
  let base: string;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 1);
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-device-client-'));
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const at = h.app.server.address();
    if (!at || typeof at === 'string') throw new Error('not listening');
    base = `http://127.0.0.1:${at.port}`;
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('pairs, says what it is, and sends a file as bytes, a Blob and a stream — each arriving whole', async () => {
    const api = createApi(
      createHttp({
        baseUrl: base,
        fetch: (url, init) => globalThis.fetch(url, init as RequestInit),
      }),
    );
    const owner = await api.setup({
      household_name: 'The Client family',
      display_name: 'Owner',
      email: 'client-owner@example.test',
      password: 'correct horse battery',
    });
    const pairing = await api.createDevicePairing(owner.access_token);
    const paired = await api.pairDevice({
      code: pairing.code,
      device_name: 'Node laptop',
      platform: 'linux',
    });
    const device = { device_id: paired.device_id, key: paired.key };
    expect(await api.deviceMe(device)).toMatchObject({ device_name: 'Node laptop', active: true });

    const file = path.join(dir, 'scan.pdf');
    await writeFile(file, PDF);
    const sent = [
      await api.deviceUpload(
        device,
        { kind: 'bytes', filename: 'bytes.pdf', contentType: 'application/pdf', bytes: PDF },
        randomUUID(),
      ),
      await api.deviceUpload(
        device,
        { kind: 'blob', filename: 'blob.pdf', blob: await openAsBlob(file) },
        randomUUID(),
        { relativePath: 'Scans/blob.pdf' },
      ),
      await api.deviceUpload(
        device,
        {
          kind: 'stream',
          filename: 'iterable.pdf',
          contentType: 'application/pdf',
          stream: Readable.from([PDF.subarray(0, 1000), PDF.subarray(1000)]),
        },
        randomUUID(),
      ),
      await api.deviceUpload(
        device,
        {
          kind: 'stream',
          filename: 'web-stream.pdf',
          contentType: 'application/pdf',
          stream: Readable.toWeb(Readable.from([PDF])) as unknown as {
            getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
          },
        },
        randomUUID(),
        { relativePath: 'Scans/web-stream.pdf' },
      ),
    ];
    expect(sent.every((s) => s.status === 'waiting')).toBe(true);
    // Each arrived whole: the vault's hash of what it stored is the file's.
    const want = createHash('sha256').update(PDF).digest('hex');
    const kept = await admin.query<{ original_name: string; sha256: Buffer }>(
      'select original_name, sha256 from incoming_file where id = any($1) order by original_name',
      [sent.map((s) => s.item_id)],
    );
    expect(kept.rows.map((r) => [r.original_name, r.sha256.toString('hex')])).toEqual(
      ['blob.pdf', 'bytes.pdf', 'iterable.pdf', 'web-stream.pdf'].map((n) => [n, want]),
    );
    // And the key, under plain fetch too, opens nothing else.
    const refused = await globalThis.fetch(`${base}/api/v1/batches`, {
      headers: { authorization: `Device ${paired.device_id}.${paired.key}` },
    });
    expect(refused.status).toBe(401);
  }, 60_000);
});
