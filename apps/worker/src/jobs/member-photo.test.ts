import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import {
  deriveKey,
  EncryptStream,
  EnvKeyProvider,
  memberPhotoBinding,
  memberPhotoSourceBinding,
  newKey,
  openBytes,
  ScopeKeys,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter, memberPhotoUploadKey } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMemberPhoto, type MemberPhotoJob } from './member-photo.js';
import { detectTools, jpegSize, type PhotoCrop } from './tools.js';

const run = promisify(execFile);
const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/**
 * An APP1 Exif block saying "turn me a quarter to the right" (orientation
 * 6), and a GPS-ish string besides, spliced in after a JPEG's first marker.
 */
function withExif(jpeg: Buffer): Buffer {
  const tiff = Buffer.from(
    ['4d4d002a00000008', '0001', '011200030000000100060000', '00000000'].join(''),
    'hex',
  );
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    tiff,
    Buffer.from('51.5007N0.1246W'),
  ]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

/** A PNG a few hundred bytes long whose header says it is 60,000 pixels square. */
function pixelBomb(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(60_000, 0);
  ihdr.writeUInt32BE(60_000, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(4096))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const tools = await detectTools();
const magickBin = async () =>
  run('magick', ['-version'])
    .then(() => 'magick')
    .catch(() => 'convert');
const heic =
  tools.magick &&
  (await magickBin()
    .then((bin) => run(bin, ['-list', 'format']))
    .then(({ stdout }) => /^\s*HEIC\*?\s+\S+\s+rw/m.test(stdout))
    .catch(() => false));

/** A household with one person and a vault, and a way to send that person a photo. */
function photoVault() {
  const state = {
    tdb: null as unknown as TestDatabase,
    db: null as unknown as Db,
    admin: null as unknown as pg.Pool,
    vaultDir: '',
    scratch: '',
    hh: randomUUID(),
    member: '',
    account: '',
  };
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const adapter = () => new LocalAdapter(state.vaultDir);
  const deps = () => ({
    db: state.db,
    keys,
    credentialsKey: deriveKey(MASTER, 'vault-credentials'),
    localRoot: state.vaultDir,
    log: () => undefined,
  });

  beforeAll(async () => {
    state.tdb = await createTestDatabase();
    state.db = createDb(createPool(state.tdb.appUrl, 3));
    state.admin = new pg.Pool({ connectionString: state.tdb.adminUrl, max: 1 });
    state.vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-photo-vault-'));
    state.scratch = await mkdtemp(path.join(tmpdir(), 'fdv-photo-src-'));
    const { hh } = state;
    await state.admin.query("insert into household (id, name) values ($1, 'Photos')", [hh]);
    state.member = (
      await state.admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Aisha') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    state.account = (
      await state.admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [`photos-${hh}@example.test`],
      )
    ).rows[0]?.id as string;
    await withSystem(state.db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      const v = await trx
        .insertInto('vault')
        .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('household')
        .set({ active_vault_id: v.id })
        .where('id', '=', hh)
        .execute();
    });
  }, 60_000);
  afterAll(async () => {
    await state.db?.destroy();
    await state.admin?.end();
    await state.tdb?.drop();
    if (state.vaultDir) await rm(state.vaultDir, { recursive: true, force: true });
    if (state.scratch) await rm(state.scratch, { recursive: true, force: true });
  });

  /** A photo on its way, as the API leaves one: sealed in the vault, and a row. */
  async function send(plain: Buffer, crop: PhotoCrop | null = null) {
    const { hh, member } = state;
    const photoId = randomUUID();
    const fileKey = newKey();
    const key = memberPhotoUploadKey({ householdId: hh, memberId: member, photoId });
    const enc = new EncryptStream(fileKey);
    await Promise.all([adapter().put(key, enc), pipeline(Readable.from([plain]), enc)]);
    await withSystem(state.db, hh, async (trx) => {
      const scope = await keys.unwrap(trx, { householdId: hh, kind: 'household' });
      const vault = await trx.selectFrom('vault').select('id').executeTakeFirstOrThrow();
      // The newest choice wins, as the API's PUT does.
      await trx
        .deleteFrom('member_photo')
        .where('member_id', '=', member)
        .where('state', '<>', 'ready')
        .execute();
      await trx
        .insertInto('member_photo')
        .values({
          id: photoId,
          household_id: hh,
          member_id: member,
          crop: crop ? JSON.stringify(crop) : null,
          source_key: key,
          source_vault_id: vault.id,
          source_key_wrapped: wrapKey(
            fileKey,
            scope.key,
            memberPhotoSourceBinding(hh, member, photoId),
          ),
          created_by: state.account,
        })
        .execute();
    });
    const job: MemberPhotoJob = { household_id: hh, member_id: member, photo_id: photoId };
    return { photoId, key, job };
  }

  const row = (photoId: string) =>
    state.admin
      .query<{
        state: string;
        sealed: Buffer | null;
        source_key: string | null;
        source_key_wrapped: Buffer | null;
        source_vault_id: string | null;
      }>(
        'select state, sealed, source_key, source_key_wrapped, source_vault_id from member_photo where id = $1',
        [photoId],
      )
      .then((r) => r.rows[0]);

  /** The square, opened as the API opens it. */
  async function square(photoId: string): Promise<Buffer> {
    const sealed = (await row(photoId))?.sealed as Buffer;
    const key = await withSystem(state.db, state.hh, (trx) =>
      keys.unwrap(trx, { householdId: state.hh, kind: 'household' }),
    );
    return openBytes(key.key, sealed, memberPhotoBinding(state.hh, state.member, photoId));
  }

  const exists = (key: string) =>
    stat(path.join(state.vaultDir, key)).then(
      () => true,
      () => false,
    );

  return { state, keys, deps, send, row, square, exists };
}

describe.skipIf(!testAdminUrl())('a photo job with nothing left to do', () => {
  const v = photoVault();

  it('a job for a photo replaced or removed meanwhile does nothing', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\n not really', 'latin1');
    // Replaced: a newer photo was sent before this one's job ran.
    const first = await v.send(png);
    const second = await v.send(png);
    expect(await makeMemberPhoto(v.deps(), first.job)).toBe('nothing');
    expect((await v.row(second.photoId))?.state).toBe('processing');
    // Removed: nothing of it is left.
    await v.state.admin.query('delete from member_photo where id = $1', [second.photoId]);
    expect(await makeMemberPhoto(v.deps(), second.job)).toBe('nothing');
    // Given up on already: a stray job for it does nothing.
    const third = await v.send(png);
    await v.state.admin.query(
      `update member_photo set state = 'failed', source_key = null, source_vault_id = null,
              source_key_wrapped = null where id = $1`,
      [third.photoId],
    );
    expect(await makeMemberPhoto(v.deps(), third.job)).toBe('nothing');
  });
});

// ImageMagick is in the worker image and on CI; not on every desk.
describe.skipIf(!testAdminUrl() || !tools.magick)('making a person’s photo', () => {
  const v = photoVault();
  const file = (name: string) => path.join(v.state.scratch, name);
  /** A picture drawn by ImageMagick, as bytes. */
  async function draw(args: string[], out: string): Promise<Buffer> {
    await run(await magickBin(), [...args, out]);
    return readFile(out.replace(/^[a-z0-9]+:/, ''));
  }
  /** One pixel of a JPEG, as ImageMagick reads it: [r, g, b]. */
  async function pixel(jpeg: Buffer, x: number, y: number): Promise<number[]> {
    const at = file(`probe-${randomUUID()}.jpg`);
    await writeFile(at, jpeg);
    const { stdout } = await run(await magickBin(), [
      `jpeg:${at}`,
      '-format',
      `%[fx:int(255*p{${x},${y}}.r)],%[fx:int(255*p{${x},${y}}.g)],%[fx:int(255*p{${x},${y}}.b)]`,
      'info:',
    ]);
    return stdout.trim().split(',').map(Number);
  }
  const near = (got: number[], want: number[]) =>
    got.every((c, i) => Math.abs(c - (want[i] as number)) < 40);

  it('a photo becomes one 512-pixel square JPEG, upright, with no EXIF or GPS', async () => {
    // Landscape, red on the left and blue on the right, and an Exif block
    // saying it was taken turned a quarter: upright, red is on top.
    const wide = await draw(
      ['-size', '600x300', 'xc:blue', '-fill', 'red', '-draw', 'rectangle 0,0 299,299'],
      `jpeg:${file('wide.jpg')}`,
    );
    const sent = await v.send(withExif(wide));
    expect(await makeMemberPhoto(v.deps(), sent.job)).toBe('ready');
    const jpeg = await v.square(sent.photoId);
    expect(jpegSize(jpeg)).toEqual({ width: 512, height: 512 });
    expect(jpeg.length).toBeLessThanOrEqual(256 * 1024);
    expect(jpeg.includes(Buffer.from('Exif'))).toBe(false);
    expect(jpeg.includes(Buffer.from('51.5007N'))).toBe(false);
    expect(jpeg.includes(Buffer.from([0xff, 0xe1]))).toBe(false);
    expect(near(await pixel(jpeg, 256, 40), [255, 0, 0])).toBe(true);
    expect(near(await pixel(jpeg, 256, 470), [0, 0, 255])).toBe(true);
    // Ready, sealed, and nothing left of the upload: the row's key to it
    // is gone, and so is the object.
    expect(await v.row(sent.photoId)).toMatchObject({
      state: 'ready',
      source_key: null,
      source_key_wrapped: null,
      source_vault_id: null,
    });
    expect(await v.exists(sent.key)).toBe(false);
    // The database holds only ciphertext.
    const sealed = (await v.row(sent.photoId))?.sealed as Buffer;
    expect(sealed.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    // And the activity log says it, once: the first photo, not a change.
    const said = await v.state.admin.query<{ action: string; detail: unknown }>(
      "select action, detail from audit_event where action = 'member.photo_changed' and object_id = $1",
      [v.state.member],
    );
    expect(said.rows).toEqual([{ action: 'member.photo_changed', detail: { replaced: false } }]);
  }, 120_000);

  it('the chosen crop is kept; with none, the middle', async () => {
    // Four bands, left to right: red, green, blue, yellow.
    const bands = await draw(
      [
        '-size',
        '800x400',
        'xc:yellow',
        '-fill',
        'red',
        '-draw',
        'rectangle 0,0 199,399',
        '-fill',
        'lime',
        '-draw',
        'rectangle 200,0 399,399',
        '-fill',
        'blue',
        '-draw',
        'rectangle 400,0 599,399',
      ],
      `png:${file('bands.png')}`,
    );
    const middle = await v.send(bands);
    expect(await makeMemberPhoto(v.deps(), middle.job)).toBe('ready');
    const m = await v.square(middle.photoId);
    // The middle square: green on its left, blue on its right.
    expect(near(await pixel(m, 60, 256), [0, 255, 0])).toBe(true);
    expect(near(await pixel(m, 450, 256), [0, 0, 255])).toBe(true);

    const chosen = await v.send(bands, { x: 0.75, y: 0.25, w: 0.25, h: 0.5 });
    expect(await makeMemberPhoto(v.deps(), chosen.job)).toBe('ready');
    const c = await v.square(chosen.photoId);
    for (const [x, y] of [
      [20, 20],
      [256, 256],
      [490, 490],
    ] as const) {
      expect(near(await pixel(c, x, y), [255, 255, 0]), `${x},${y}`).toBe(true);
    }
    // The newer replaced the older, which is gone; the log says it changed.
    const kept = await v.state.admin.query<{ id: string }>(
      "select id from member_photo where member_id = $1 and state = 'ready'",
      [v.state.member],
    );
    expect(kept.rows.map((r) => r.id)).toEqual([chosen.photoId]);
    const said = await v.state.admin.query<{ detail: { replaced: boolean } }>(
      "select detail from audit_event where action = 'member.photo_changed' order by id desc limit 1",
    );
    expect(said.rows[0]?.detail).toEqual({ replaced: true });
  }, 120_000);

  it.skipIf(!heic)(
    'a HEIC photo is squared',
    async () => {
      const photo = await draw(['-size', '1200x900', 'xc:#cc8844'], `heic:${file('photo.heic')}`);
      const sent = await v.send(photo);
      expect(await makeMemberPhoto(v.deps(), sent.job)).toBe('ready');
      expect(jpegSize(await v.square(sent.photoId))).toEqual({ width: 512, height: 512 });
    },
    120_000,
  );

  it('a transparent PNG is flattened onto white', async () => {
    const clear = await draw(['-size', '300x300', 'xc:none'], `png32:${file('clear.png')}`);
    const sent = await v.send(clear);
    expect(await makeMemberPhoto(v.deps(), sent.job)).toBe('ready');
    expect(near(await pixel(await v.square(sent.photoId), 256, 256), [255, 255, 255])).toBe(true);
  }, 120_000);

  it('a picture claiming 60,000 pixels square is refused, not decoded', async () => {
    const sent = await v.send(pixelBomb());
    const started = Date.now();
    // The queue tries again before it gives up: until then it stays on its way.
    await expect(makeMemberPhoto(v.deps(), sent.job, { final: false })).rejects.toThrow();
    expect((await v.row(sent.photoId))?.state).toBe('processing');
    expect(await makeMemberPhoto(v.deps(), sent.job, { final: true })).toBe('failed');
    expect(Date.now() - started).toBeLessThan(40_000);
    // Refused: failed, and the upload gone at once.
    expect(await v.row(sent.photoId)).toMatchObject({
      state: 'failed',
      sealed: null,
      source_key: null,
    });
    expect(await v.exists(sent.key)).toBe(false);
  }, 120_000);

  it('a file that is not a photo is refused as what it is, not decoded', async () => {
    for (const bytes of [
      Buffer.from('%PDF-1.4\n%%EOF\n'),
      // A TIFF, which pages may be, but a photo is not made from.
      Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
    ]) {
      const sent = await v.send(bytes);
      expect(await makeMemberPhoto(v.deps(), sent.job)).toBe('failed');
      expect(await v.exists(sent.key)).toBe(false);
    }
  }, 120_000);
});
