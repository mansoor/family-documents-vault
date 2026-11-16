import { PassThrough, Readable } from 'node:stream';
import { StorageError } from '@fdv/storage';
import { ZIP_LEFT_OUT } from '@fdv/shared';
import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';
import { DOWNLOAD_TICKET_MS, DownloadTickets } from './zip-routes.js';
import { zipStream, type ZipIndexRow, type ZipPlan } from './zip.js';

/**
 * The ZIP as it is written (0.9.0, DL; the DL review), with no vault: files
 * in turn and the index last; a file not where the files are kept left
 * out and said so; a reader gone while a file is opened closes that file;
 * and the tickets a browser follows, good once for a minute.
 */

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function entries(body: Buffer): Promise<Map<string, string>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(body, { lazyEntries: true }, (err, z) => (err ? reject(err) : resolve(z))),
  );
  const out = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.on('entry', (e: yauzl.Entry) =>
      zip.openReadStream(e, (err, s) => {
        if (err) return reject(err);
        void collect(s).then((b) => {
          out.set(e.fileName, b.toString('utf8'));
          zip.readEntry();
        }, reject);
      }),
    );
    zip.readEntry();
  });
  return out;
}

const row = (title: string, file: string): ZipIndexRow => ({
  title,
  kind: null,
  file,
  left_out: null,
});

describe('the ZIP as it is written (DL)', () => {
  it('files in turn, then the index last; one not there left out and said so, the rest go on', async () => {
    const a = row('Alpha', 'Alpha.pdf');
    const gone = row('Gone', 'Gone.pdf');
    const b = row('Beta', 'Beta.pdf');
    const plan: ZipPlan = {
      filename: 'x.zip',
      heading: 'Test',
      full: false,
      rows: [a, gone, b],
      files: [
        { name: 'Alpha.pdf', row: a, open: async () => Readable.from([Buffer.from('alpha')]) },
        {
          name: 'Gone.pdf',
          row: gone,
          open: async () => {
            throw new StorageError('not_found', 'not there');
          },
        },
        { name: 'Beta.pdf', row: b, open: async () => 'beta' },
      ],
    };
    const got = await entries(await collect(zipStream(plan)));
    expect([...got.keys()]).toEqual(['Alpha.pdf', 'Beta.pdf', 'index.html', 'index.csv']);
    expect(got.get('Alpha.pdf')).toBe('alpha');
    expect(got.get('index.csv')).toContain(`Gone,,,${ZIP_LEFT_OUT.not_there}`);
    expect(got.get('index.html')).not.toContain('href="Gone.pdf"');
    expect(got.get('index.html')).toContain('2 files in this download');
  });

  it('any other trouble opening a file ends the ZIP', async () => {
    const r = row('Broken', 'Broken.pdf');
    const plan: ZipPlan = {
      filename: 'x.zip',
      heading: 'Test',
      full: false,
      rows: [r],
      files: [
        {
          name: 'Broken.pdf',
          row: r,
          open: async () => {
            throw new StorageError('permission_denied', 'no');
          },
        },
      ],
    };
    const errors: unknown[] = [];
    await expect(collect(zipStream(plan, (e) => errors.push(e)))).rejects.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('a reader gone while a file was being opened: that file is closed, nothing more read', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const source = new PassThrough();
    let laterOpened = false;
    const plan: ZipPlan = {
      filename: 'x.zip',
      heading: 'Test',
      full: false,
      rows: [],
      files: [
        {
          name: 'Slow.pdf',
          open: async () => {
            await waiting;
            return source;
          },
        },
        {
          name: 'Later.pdf',
          open: async () => {
            laterOpened = true;
            return 'later';
          },
        },
      ],
    };
    const zip = zipStream(plan);
    zip.on('error', () => undefined);
    zip.destroy();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(source.destroyed).toBe(true);
    expect(laterOpened).toBe(false);
  });
});

describe('download tickets (DL)', () => {
  it('good once, for a minute, and never past it', () => {
    let now = 1_000_000;
    const tickets = new DownloadTickets(() => now);
    const made = tickets.make('bearer', { kind: 'collection', id: 'c' });
    expect(made.ticket).toMatch(/^[\w-]{43}$/);
    expect(Date.parse(made.expires_at)).toBe(now + DOWNLOAD_TICKET_MS);
    expect(tickets.take(made.ticket)).toMatchObject({ bearer: 'bearer' });
    expect(tickets.take(made.ticket)).toBeNull();
    const late = tickets.make('bearer', { kind: 'selection', ids: ['a'] });
    now += DOWNLOAD_TICKET_MS;
    expect(tickets.take(late.ticket)).toBeNull();
    expect(tickets.take('never-made')).toBeNull();
  });
});
