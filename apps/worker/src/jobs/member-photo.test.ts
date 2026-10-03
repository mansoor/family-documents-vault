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
import {
  detectTools,
  jpegSize,
  photoPlan,
  PHOTO_DECODE_PIXELS,
  webpOrientation,
  type PhotoCrop,
} from './tools.js';

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
/** Whether ImageMagick here writes this format: a picture of it can be made for a test. */
const writes = async (format: string) =>
  tools.magick &&
  (await magickBin()
    .then((bin) => run(bin, ['-list', 'format']))
    .then(({ stdout }) => new RegExp(`^\\s*${format}\\*?\\s+\\S+\\s+rw`, 'm').test(stdout))
    .catch(() => false));
const webp = await writes('WEBP');
/** libheif's own encoder: a 48 megapixel HEIC in seconds, where ImageMagick takes a minute. */
const heifEnc = await run('heif-enc', ['--version'])
  .then(() => true)
  .catch(() => false);

/**
 * A picture of four quarters as stored, as raw YUV 4:2:0 (Y4M), which
 * heif-enc reads as it is: red, lime / blue, yellow.
 */
function quartersY4m(w: number, h: number): Buffer {
  // BT.601, limited range, as heif-enc takes a Y4M.
  const yuv: Record<string, [number, number, number]> = {
    red: [81, 90, 240],
    lime: [145, 54, 34],
    blue: [41, 240, 110],
    yellow: [210, 16, 146],
  };
  const at = (x: number, y: number) =>
    yuv[y < h / 2 ? (x < w / 2 ? 'red' : 'lime') : x < w / 2 ? 'blue' : 'yellow'] as [
      number,
      number,
      number,
    ];
  const head = Buffer.from(`YUV4MPEG2 W${w} H${h} F1:1 Ip A1:1 C420jpeg\nFRAME\n`, 'latin1');
  const Y = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const left = at(0, y)[0];
    const right = at(w - 1, y)[0];
    Y.fill(left, y * w, y * w + w / 2);
    Y.fill(right, y * w + w / 2, y * w + w);
  }
  const cw = w / 2;
  const ch = h / 2;
  const U = Buffer.alloc(cw * ch);
  const V = Buffer.alloc(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (const [plane, i] of [
      [U, 1],
      [V, 2],
    ] as const) {
      plane.fill(at(0, y * 2)[i], y * cw, y * cw + cw / 2);
      plane.fill(at(w - 1, y * 2)[i], y * cw + cw / 2, y * cw + cw);
    }
  }
  return Buffer.concat([head, Y, U, V]);
}

/**
 * A WebP with an EXIF chunk saying which way up it is, as `cwebp -metadata
 * exif` writes one: the image's own chunk kept, a VP8X saying there is EXIF.
 */
function webpWithExif(simple: Buffer, orientation: number, w: number, h: number): Buffer {
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const image: Buffer[] = [];
  for (let at = 12; at + 8 <= simple.length;) {
    const id = simple.toString('latin1', at, at + 4);
    const size = simple.readUInt32LE(at + 4);
    if (id === 'VP8 ' || id === 'VP8L') image.push(simple.subarray(at, at + 8 + size + (size % 2)));
    at += 8 + size + (size % 2);
  }
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08; // EXIF
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const tiff = Buffer.from(
    ['4d4d002a00000008', '0001', `0112000300000001000${orientation}0000`, '00000000'].join(''),
    'hex',
  );
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    chunk('VP8X', vp8x),
    ...image,
    chunk('EXIF', tiff),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

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
    // A connection the server ends as the database is dropped is said on
    // the pool, not an unhandled error (the 5.23 review).
    state.admin.on('error', () => undefined);
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

  it('a 64-megapixel photo, and a 48-megapixel one taken upright, are made within the limits', async () => {
    // The 5.17c review: decoded whole, and again to turn it upright, a
    // phone's 48 or 64 megapixel photo ran out of room ('cache resources
    // exhausted') long before the 128 megapixel limit. Four quadrants:
    // red, lime / blue, yellow.
    const quadrants = (w: number, h: number) => [
      '-size',
      `${w}x${h}`,
      'xc:yellow',
      '-fill',
      'red',
      '-draw',
      `rectangle 0,0 ${w / 2 - 1},${h / 2 - 1}`,
      '-fill',
      'lime',
      '-draw',
      `rectangle ${w / 2},0 ${w - 1},${h / 2 - 1}`,
      '-fill',
      'blue',
      '-draw',
      `rectangle 0,${h / 2} ${w / 2 - 1},${h - 1}`,
      '-quality',
      '90',
    ];
    const big = await draw(quadrants(9248, 6936), `jpeg:${file('64mp.jpg')}`);
    expect(jpegSize(big)).toEqual({ width: 9248, height: 6936 });
    // Its top right quarter: lime.
    const wide = await v.send(big, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
    const started = Date.now();
    expect(await makeMemberPhoto(v.deps(), wide.job)).toBe('ready');
    const w = await v.square(wide.photoId);
    expect(jpegSize(w)).toEqual({ width: 512, height: 512 });
    for (const [x, y] of [
      [20, 20],
      [256, 256],
      [490, 490],
    ] as const) {
      expect(near(await pixel(w, x, y), [0, 255, 0]), `${x},${y}`).toBe(true);
    }
    // Turned a quarter by its Exif, as a phone held upright writes it: its
    // upright bottom right quarter is what was stored top right, lime; had
    // it not been turned, it would be yellow.
    const tall = withExif(await draw(quadrants(8064, 6048), `jpeg:${file('48mp.jpg')}`));
    const upright = await v.send(tall, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(await makeMemberPhoto(v.deps(), upright.job)).toBe('ready');
    const t = await v.square(upright.photoId);
    for (const [x, y] of [
      [20, 20],
      [256, 256],
      [490, 490],
    ] as const) {
      expect(near(await pixel(t, x, y), [0, 255, 0]), `${x},${y}`).toBe(true);
    }
    // Decoded small, both are quick.
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 240_000);

  /** The four quarters of a square made from the middle of a picture of four quarters. */
  async function quartersOf(jpeg: Buffer) {
    expect(jpegSize(jpeg)).toEqual({ width: 512, height: 512 });
    expect(near(await pixel(jpeg, 100, 100), [255, 0, 0]), 'top left').toBe(true);
    expect(near(await pixel(jpeg, 412, 100), [0, 255, 0]), 'top right').toBe(true);
    expect(near(await pixel(jpeg, 100, 412), [0, 0, 255]), 'bottom left').toBe(true);
    expect(near(await pixel(jpeg, 412, 412), [255, 255, 0]), 'bottom right').toBe(true);
  }
  /** The crop sheet's own middle square of a 4:3 picture. */
  const MIDDLE = { x: 0.125, y: 0, w: 0.75, h: 1 };

  it.skipIf(!heifEnc || !heic)(
    "a 48-megapixel HEIC, an iPhone's HEIF Max, is made with the sheet's middle square",
    async () => {
      // The 5.17c images check: decoded whole, then cut twice, it ran out
      // of room ('cache resources exhausted') on ImageMagick 7 Q16-HDRI.
      const y4m = file('heic48.y4m');
      await writeFile(y4m, quartersY4m(8064, 6048));
      const out = file('heic48.heic');
      await run('heif-enc', ['-e', 'x265', '-p', 'preset=ultrafast', '-q', '30', '-o', out, y4m]);
      const sent = await v.send(await readFile(out), MIDDLE);
      const started = Date.now();
      expect(await makeMemberPhoto(v.deps(), sent.job)).toBe('ready');
      await quartersOf(await v.square(sent.photoId));
      expect(Date.now() - started).toBeLessThan(60_000);
    },
    240_000,
  );

  it.skipIf(!webp)(
    'a 50-megapixel WebP is made with the middle square',
    async () => {
      const big = await draw(
        [
          '-size',
          '8160x6120',
          'xc:yellow',
          '-fill',
          'red',
          '-draw',
          'rectangle 0,0 4079,3059',
          '-fill',
          'lime',
          '-draw',
          'rectangle 4080,0 8159,3059',
          '-fill',
          'blue',
          '-draw',
          'rectangle 0,3060 4079,6119',
          '-quality',
          '80',
        ],
        `webp:${file('webp50.webp')}`,
      );
      const sent = await v.send(big, MIDDLE);
      expect(await makeMemberPhoto(v.deps(), sent.job)).toBe('ready');
      await quartersOf(await v.square(sent.photoId));
    },
    240_000,
  );

  it.skipIf(!webp)(
    'a WebP whose EXIF says it was taken turned is cut where the crop says, upright',
    async () => {
      // The 5.17c images check: ImageMagick 7's ping reads no WebP
      // orientation, so its part was planned as stored and then turned.
      // Stored 1600 by 1200, four quarters; EXIF 6: upright, the stored
      // left is on top, so the upright top right quarter is red and the
      // bottom left yellow.
      const stored = await draw(
        [
          '-size',
          '1600x1200',
          'xc:yellow',
          '-fill',
          'red',
          '-draw',
          'rectangle 0,0 799,599',
          '-fill',
          'lime',
          '-draw',
          'rectangle 800,0 1599,599',
          '-fill',
          'blue',
          '-draw',
          'rectangle 0,600 799,1199',
          '-strip',
          '-quality',
          '90',
        ],
        `webp:${file('turned.webp')}`,
      );
      const turned = webpWithExif(stored, 6, 1600, 1200);
      expect(webpOrientation(turned)).toBe('RightTop');
      for (const [crop, want] of [
        [{ x: 0.5, y: 0, w: 0.5, h: 0.5 }, [255, 0, 0]],
        [{ x: 0, y: 0.5, w: 0.5, h: 0.5 }, [255, 255, 0]],
        [{ x: 0, y: 0, w: 0.5, h: 0.5 }, [0, 0, 255]],
      ] as const) {
        const sent = await v.send(turned, crop);
        expect(await makeMemberPhoto(v.deps(), sent.job)).toBe('ready');
        const sq = await v.square(sent.photoId);
        for (const [x, y] of [
          [40, 40],
          [256, 256],
          [470, 470],
        ] as const) {
          expect(near(await pixel(sq, x, y), [...want]), `${JSON.stringify(crop)} ${x},${y}`).toBe(
            true,
          );
        }
      }
    },
    240_000,
  );

  it('a picture placed off its canvas is cut where it is seen', async () => {
    // The 5.17c review: a PNG whose oFFs puts it at +300+300 was cut on
    // the canvas, not the picture — a blue corner, or a white square —
    // and still marked ready. Red, with a blue top left quarter.
    const placed = await draw(
      [
        '-size',
        '400x400',
        'xc:red',
        '-fill',
        'blue',
        '-draw',
        'rectangle 0,0 199,199',
        '-repage',
        '+300+300',
      ],
      `png:${file('placed.png')}`,
    );
    const quarter = await v.send(placed, { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(await makeMemberPhoto(v.deps(), quarter.job)).toBe('ready');
    const q = await v.square(quarter.photoId);
    for (const [x, y] of [
      [20, 20],
      [256, 256],
      [490, 490],
    ] as const) {
      expect(near(await pixel(q, x, y), [0, 0, 255]), `${x},${y}`).toBe(true);
    }
    // The middle: the whole picture, its blue quarter where it is.
    const whole = await v.send(placed);
    expect(await makeMemberPhoto(v.deps(), whole.job)).toBe('ready');
    const m = await v.square(whole.photoId);
    expect(near(await pixel(m, 100, 100), [0, 0, 255])).toBe(true);
    expect(near(await pixel(m, 400, 400), [255, 0, 0])).toBe(true);
    expect(near(await pixel(m, 400, 100), [255, 0, 0])).toBe(true);
  }, 120_000);

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

describe('how a photo is decoded, and what of it is cut', () => {
  it('a JPEG as small as keeps the part 512 pixels a side, and no more than PHOTO_DECODE_PIXELS', () => {
    // The middle of a 64 megapixel photo: decoded at an eighth, its short
    // side is 867, and the middle square of it is cut.
    const middle = photoPlan({ w: 9248, h: 6936 }, 'TopLeft', null, true);
    expect(middle.shrink).toBe(8);
    expect(middle.part).toEqual({ x: 1156 / 9248, y: 0, w: 6936 / 9248, h: 1 });
    // A quarter of it: decoded at a quarter, that part is 1156 across.
    expect(
      photoPlan({ w: 9248, h: 6936 }, 'TopLeft', { x: 0.5, y: 0, w: 0.5, h: 0.5 }, true),
    ).toEqual({ part: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, shrink: 4 });
    // A small part of a huge one: decoded at a half, never whole.
    const tiny = photoPlan(
      { w: 12000, h: 9000 },
      'TopLeft',
      { x: 0, y: 0, w: 0.05, h: 0.05 },
      true,
    );
    expect(tiny.shrink).toBe(2);
    expect((12000 * 9000) / tiny.shrink ** 2).toBeLessThanOrEqual(PHOTO_DECODE_PIXELS);
    // Not a JPEG: decoded whole, as nothing else can be shrunk as it is read.
    expect(photoPlan({ w: 9248, h: 6936 }, 'TopLeft', null, false).shrink).toBe(1);
    // A photo already small is not shrunk.
    expect(photoPlan({ w: 600, h: 400 }, 'Undefined', null, true)).toEqual({
      part: { x: 100 / 600, y: 0, w: 400 / 600, h: 1 },
      shrink: 1,
    });
  });

  it('the part of the upright picture is found where it is stored, for every EXIF turn', () => {
    // The upright top left quarter of a picture 400 wide and 200 tall.
    const quarter = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const at = (o: string, stored = { w: 400, h: 200 }) => photoPlan(stored, o, quarter, true).part;
    expect(at('TopLeft')).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(at('TopRight')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(at('BottomRight')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(at('BottomLeft')).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    // Turned a quarter: stored 200 wide and 400 tall.
    const tall = { w: 200, h: 400 };
    expect(at('LeftTop', tall)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(at('RightTop', tall)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(at('RightBottom', tall)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(at('LeftBottom', tall)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  });
});

describe("a WebP's orientation, from its EXIF chunk", () => {
  it('is read from the chunk, in either byte order, with or without the Exif header', () => {
    const riff = (chunks: Array<[string, Buffer]>) => {
      const parts = chunks.map(([id, body]) => {
        const head = Buffer.alloc(8);
        head.write(id, 0, 'latin1');
        head.writeUInt32LE(body.length, 4);
        return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
      });
      const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...parts]);
      const head = Buffer.alloc(8);
      head.write('RIFF', 0, 'latin1');
      head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body]);
    };
    const big = Buffer.from('4d4d002a000000080001011200030000000100060000' + '00000000', 'hex');
    const little = Buffer.from(
      '49492a000800000001001201030001000000030000000000' + '00000000',
      'hex',
    );
    const image: [string, Buffer] = ['VP8 ', Buffer.alloc(9)];
    expect(webpOrientation(riff([['VP8X', Buffer.alloc(10)], image, ['EXIF', big]]))).toBe(
      'RightTop',
    );
    expect(webpOrientation(riff([image, ['EXIF', little]]))).toBe('BottomRight');
    expect(
      webpOrientation(
        riff([image, ['EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), big])]]),
      ),
    ).toBe('RightTop');
    // None, or not a WebP at all.
    expect(webpOrientation(riff([image]))).toBeNull();
    expect(webpOrientation(Buffer.from('not a webp'))).toBeNull();
    expect(webpOrientation(riff([image, ['EXIF', Buffer.from('junk')]]))).toBeNull();
  });
});
