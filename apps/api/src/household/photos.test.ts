import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import {
  DecryptStream,
  EnvKeyProvider,
  memberPhotoBinding,
  memberPhotoSourceBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { appendAudit, createPool, verifyAuditChain, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  PHOTO_REFUSAL,
  refusalFor,
  type Capabilities,
  type Member,
  type ShareLinkPreview,
} from '@fdv/shared';
import { LocalAdapter, readAll } from '@fdv/storage';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { parseCrop } from './photos.js';

/**
 * A person's photo (5.17c), from the API's side: who may set whose (A66),
 * who sees what (A65), what the vault takes and what it keeps — which is
 * nothing of the file but, once the worker has made it, the square, sealed.
 *
 * The worker is not here: `finish` stands in for it, committing what
 * jobs/member-photo.ts commits, with a square made elsewhere. The worker's
 * own test (member-photo.test.ts) makes real squares with ImageMagick.
 */

/** A JPEG as a phone sends one: its markers, an Exif block with a place in it, and pixels. */
const GPS = '51.5007N0.1246W';
const PHOTO = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x1c]),
  Buffer.from(`Exif\0\0${GPS}\0\0\0\0\0`, 'latin1'),
  Buffer.from([0xff, 0xdb]),
  randomBytes(2000),
  Buffer.from([0xff, 0xd9]),
]);
/** A real PNG, 16 pixels square, of noise. */
const PNG = (() => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Array.from({ length: 16 }, () => Buffer.concat([Buffer.from([0]), randomBytes(48)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();
/** What the worker would have made: a JPEG, in so far as its bytes say so. */
const SQUARE = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  randomBytes(900),
  Buffer.from([0xff, 0xd9]),
]);

type Part = [name: string, value: string] | ['file', Buffer, string?, string?];

describe.skipIf(!testAdminUrl())("a person's photo (5.17c)", () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const logged: string[] = [];
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let child: string;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

  beforeAll(async () => {
    h = await createHarness({
      logger: { level: 'info', stream: { write: (s: string) => void logged.push(s) } },
    });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sam Khan', email: 'sam@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tess', email: 'tess@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Aisha', date_of_birth: '2016-04-02', relationship: 'Daughter' },
    });
    expect(added.statusCode, added.body).toBe(201);
    child = added.json<Member>().id;
    await admin.query("update member set relationship = 'Our accountant' where id = $1", [
      viewer.member_id,
    ]);
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  const put = (as: Tokens, memberId: string, parts: Part[] = [['file', PHOTO]]) => {
    const form = new FormData();
    for (const p of parts) {
      if (p[0] === 'file' && Buffer.isBuffer(p[1])) {
        form.append('file', p[1], {
          filename: p[2] ?? 'IMG_2041.jpg',
          contentType: p[3] ?? 'image/jpeg',
        });
      } else {
        form.append(p[0], p[1]);
      }
    }
    return h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${memberId}/photo`,
      headers: { ...h.as(as), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
  };
  const remove = (as: Tokens, memberId: string) =>
    h.app.inject({ method: 'DELETE', url: `/api/v1/members/${memberId}/photo`, headers: h.as(as) });
  const members = async (as: Tokens) =>
    (await h.app.inject({ url: '/api/v1/members', headers: h.as(as) })).json<{ items: Member[] }>()
      .items;
  const personAs = async (as: Tokens, id: string) =>
    (await members(as)).find((m) => m.id === id) as Member;
  const fetchPhoto = (as: Tokens | null, memberId: string, photoId: string) =>
    h.app.inject({
      url: `/api/v1/members/${memberId}/photo/${photoId}`,
      headers: as ? h.as(as) : {},
    });
  const rows = async (memberId: string) =>
    (
      await admin.query<{
        id: string;
        state: string;
        sealed: Buffer | null;
        source_key: string | null;
        source_key_wrapped: Buffer | null;
        crop: unknown;
        created_by: string | null;
      }>(
        'select id, state, sealed, source_key, source_key_wrapped, crop, created_by from member_photo where member_id = $1 order by created_at',
        [memberId],
      )
    ).rows;
  /** Every file in the vault, under a person's folder. */
  const incoming = async (memberId: string) =>
    (
      await readdir(
        path.join(h.vaultDir, owner.household_id, 'members', memberId, 'incoming'),
      ).catch(() => [] as string[])
    ).sort();

  /**
   * What the worker does once the square is made (jobs/member-photo.ts):
   * the upload opened, the square sealed into the row under the household
   * key, the person's old photo gone, this one ready and its upload's
   * columns cleared, the log's line; then the upload deleted. Returns the
   * bytes the upload held.
   */
  async function finish(memberId: string, square = SQUARE): Promise<{ id: string; sent: Buffer }> {
    const hh = owner.household_id;
    const [row] = (await rows(memberId)).filter((r) => r.state === 'processing');
    if (!row?.source_key || !row.source_key_wrapped) throw new Error('nothing on its way');
    const scope = await withSystem(h.db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'household' }),
    );
    const fileKey = unwrapKey(
      row.source_key_wrapped,
      scope.key,
      memberPhotoSourceBinding(hh, memberId, row.id),
    );
    const vault = new LocalAdapter(h.vaultDir);
    const dec = new DecryptStream(fileKey);
    const [, sent] = await Promise.all([
      pipeline(await vault.get(row.source_key), dec),
      readAll(dec),
    ]);
    await withSystem(h.db, hh, async (trx) => {
      const old = await trx
        .deleteFrom('member_photo')
        .where('member_id', '=', memberId)
        .where('state', '=', 'ready')
        .returning('id')
        .execute();
      await trx
        .updateTable('member_photo')
        .set({
          state: 'ready',
          sealed: sealBytes(scope.key, square, memberPhotoBinding(hh, memberId, row.id)),
          ready_at: new Date(),
          source_key: null,
          source_vault_id: null,
          source_key_wrapped: null,
        })
        .where('id', '=', row.id)
        .execute();
      await appendAudit(trx, {
        householdId: hh,
        actorAccountId: row.created_by,
        action: 'member.photo_changed',
        objectType: 'member',
        objectId: memberId,
        detail: { replaced: old.length > 0 },
      });
    });
    await vault.delete(row.source_key);
    return { id: row.id, sent };
  }

  it('a photo upload is read as multipart on the household routes', async () => {
    const res = await put(owner, owner.member_id);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json<Member>()).toMatchObject({
      id: owner.member_id,
      photo: null,
      photo_status: 'processing',
      can_change_photo: true,
    });
    expect(h.jobs.filter((j) => j.name === 'member.photo').at(-1)?.data).toEqual({
      household_id: owner.household_id,
      member_id: owner.member_id,
      photo_id: (await rows(owner.member_id))[0]?.id,
    });
    // Registered once, in app.ts, ahead of every route: not inside the
    // document routes, whose registration came after the household's.
    const src = fileURLToPath(new URL('..', import.meta.url));
    const app = await readFile(path.join(src, 'app.ts'), 'utf8');
    expect(app.indexOf('app.register(multipart')).toBeGreaterThan(0);
    expect(app.indexOf('app.register(multipart')).toBeLessThan(app.indexOf('registerHousehold('));
    const documents = await readFile(path.join(src, 'documents', 'routes.ts'), 'utf8');
    expect(documents).not.toMatch(/register\(multipart/);
    await finish(owner.member_id);
  });

  it("an owner sets a child's photo; owners, adults and teens see it; a viewer sees initials", async () => {
    const res = await put(owner, child, [
      ['crop', JSON.stringify({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 })],
      ['file', PHOTO],
    ]);
    expect(res.statusCode, res.body).toBe(202);
    expect((await rows(child))[0]?.crop).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
    const { id } = await finish(child);
    for (const who of [owner, adult, teen]) {
      expect((await personAs(who, child)).photo).toEqual({ id });
      const got = await fetchPhoto(who, child, id);
      expect(got.statusCode).toBe(200);
      expect(Buffer.compare(got.rawPayload, SQUARE)).toBe(0);
    }
    // A viewer is told there is no photo, and is given none by asking.
    expect((await personAs(viewer, child)).photo).toBeNull();
    const refused = await fetchPhoto(viewer, child, id);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: { code: 'no_photo' } });
  });

  it('a teen sets only their own; an adult their own and those without a sign-in; a viewer none, but removes their own', async () => {
    const status = async (as: Tokens, memberId: string) => (await put(as, memberId)).statusCode;
    // A teen: their own, nobody else's.
    expect(await status(teen, teen.member_id)).toBe(202);
    for (const other of [child, adult.member_id, owner.member_id]) {
      const r = await put(teen, other);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { code: 'forbidden', message: PHOTO_REFUSAL } });
    }
    // An adult: their own, and a child's; not another adult's or an owner's.
    expect(await status(adult, adult.member_id)).toBe(202);
    expect(await status(adult, child)).toBe(202);
    expect(await status(adult, owner.member_id)).toBe(403);
    expect(await status(adult, teen.member_id)).toBe(403);
    // An owner: anybody's.
    expect(await status(owner, adult.member_id)).toBe(202);
    // A viewer: nobody's, their own included, in the matrix's words.
    for (const other of [viewer.member_id, child]) {
      const r = await put(viewer, other);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { message: refusalFor('member.photo') } });
    }
    // But a viewer's own photo, set by an owner, they may take away.
    expect(await status(owner, viewer.member_id)).toBe(202);
    await finish(viewer.member_id);
    expect((await personAs(viewer, viewer.member_id)).photo).not.toBeNull();
    expect((await remove(viewer, child)).statusCode).toBe(403);
    expect((await remove(teen, child)).statusCode).toBe(403);
    expect((await remove(viewer, viewer.member_id)).statusCode).toBe(204);
    expect(await rows(viewer.member_id)).toEqual([]);
    expect((await personAs(viewer, viewer.member_id)).photo).toBeNull();
    // Nothing there is still 204.
    expect((await remove(viewer, viewer.member_id)).statusCode).toBe(204);
    // Somebody not in the family is not there.
    expect((await put(owner, randomUUID())).statusCode).toBe(404);
    expect((await remove(owner, randomUUID())).statusCode).toBe(404);
    // The activity log said it once, as the family reads it.
    const lines = (await h.app.inject({ url: '/api/v1/audit', headers: h.as(owner) })).json<{
      items: Array<{ text: string }>;
    }>().items;
    expect(lines.map((l) => l.text)).toContain('Vic removed their photo');
    expect(lines.map((l) => l.text)).toContain('Owner added a photo of Aisha');
  });

  it('a crop after the file, or a second file, is refused, and nothing is kept', async () => {
    const before = await rows(teen.member_id);
    const files = await incoming(teen.member_id);
    const crop = JSON.stringify({ x: 0, y: 0, w: 1, h: 1 });
    for (const parts of [
      [
        ['file', PHOTO],
        ['crop', crop],
      ],
      [
        ['file', PHOTO],
        ['file', PHOTO],
      ],
      [
        ['crop', crop],
        ['crop', crop],
        ['file', PHOTO],
      ],
      [
        ['caption', 'Me at the beach'],
        ['file', PHOTO],
      ],
      [['photo', PHOTO.toString('latin1')]],
    ] as Part[][]) {
      const r = await put(teen, teen.member_id, parts);
      expect(r.statusCode, JSON.stringify(parts.map((p) => p[0]))).toBe(422);
      expect(r.json()).toMatchObject({
        error: { code: 'validation_failed', message: 'Send the crop first, then the photo.' },
      });
    }
    expect(await rows(teen.member_id)).toEqual(before);
    expect(await incoming(teen.member_id)).toEqual(files);
  });

  it('a PDF, a TIFF or a Word file is refused as what it is; over 20 MB is 413; a crop outside the picture is 422', async () => {
    const before = await rows(adult.member_id);
    const files = await incoming(adult.member_id);
    const refusedAs = async (bytes: Buffer, name: string) => {
      // Declared a photo, named one: the bytes decide.
      const r = await put(adult, adult.member_id, [['file', bytes, name, 'image/jpeg']]);
      expect(r.statusCode, name).toBe(415);
      expect(r.json()).toMatchObject({
        error: { code: 'unsupported_type', message: 'Choose a photo: JPEG, PNG, WebP or HEIC.' },
      });
      // Never naming the file.
      expect(r.body).not.toContain(name);
      return r.json<{ error: { detail: string } }>().error.detail;
    };
    expect(
      await refusedAs(Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n'), 'secret-plans.jpg'),
    ).toBe('detected application/pdf');
    expect(
      await refusedAs(
        Buffer.concat([
          Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
          randomBytes(64),
        ]),
        'scan.jpg',
      ),
    ).toBe('detected image/tiff');
    await refusedAs(
      Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), randomBytes(200)]),
      'letter.jpg',
    );
    // Over 20 MB, counted as it arrives.
    const big = Buffer.concat([PHOTO, Buffer.alloc(20 * 1024 * 1024)]);
    const r = await put(adult, adult.member_id, [['file', big]]);
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: { code: 'too_large' } });
    // Crops outside the picture, too small, or not a crop at all.
    for (const crop of [
      { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.01, h: 0.5 },
      { x: -0.1, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.5 },
      'the middle',
    ]) {
      const bad = await put(adult, adult.member_id, [
        ['crop', typeof crop === 'string' ? crop : JSON.stringify(crop)],
        ['file', PHOTO],
      ]);
      expect(bad.statusCode, JSON.stringify(crop)).toBe(422);
      expect(bad.json()).toMatchObject({ error: { code: 'validation_failed', detail: 'crop' } });
    }
    expect(await rows(adult.member_id)).toEqual(before);
    expect(await incoming(adult.member_id)).toEqual(files);
  }, 60_000);

  it('the photo is served only with a sign-in, as image/jpeg, private and no-store', async () => {
    const [ready] = (await rows(child)).filter((r) => r.state === 'ready');
    const id = ready?.id as string;
    const anonymous = await fetchPhoto(null, child, id);
    expect(anonymous.statusCode).toBe(401);
    const got = await fetchPhoto(teen, child, id);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
  });

  it('not allowed, no photo, an old id and a seal that does not open all look the same: 404 no_photo', async () => {
    const [ready] = (await rows(child)).filter((r) => r.state === 'ready');
    const id = ready?.id as string;
    const same = async (as: Tokens, memberId: string, photoId: string) => {
      const r = await fetchPhoto(as, memberId, photoId);
      expect(r.statusCode, `${memberId} ${photoId}`).toBe(404);
      expect(r.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: 'no_photo',
        message: 'There is no photo here.',
      });
    };
    await same(viewer, child, id); // not allowed
    await same(owner, teen.member_id, randomUUID()); // no photo
    await same(owner, child, randomUUID()); // an id that is not the photo
    await same(owner, 'not-an-id', 'nor-this'); // not ids at all
    // An old id: the child's photo, replaced.
    expect((await put(owner, child)).statusCode).toBe(202);
    await finish(child);
    await same(owner, child, id);
    // A seal that does not open: the child's square, copied onto Sam.
    const [now] = (await rows(child)).filter((r) => r.state === 'ready');
    const copied = randomUUID();
    await admin.query("delete from member_photo where member_id = $1 and state = 'ready'", [
      adult.member_id,
    ]);
    await admin.query(
      `insert into member_photo (id, household_id, member_id, state, sealed, ready_at)
       values ($1, $2, $3, 'ready', $4, now())`,
      [copied, owner.household_id, adult.member_id, now?.sealed],
    );
    logged.length = 0;
    await same(owner, adult.member_id, copied);
    expect(logged.some((l) => l.includes('photo_unreadable') && l.includes(copied))).toBe(true);
    await admin.query('delete from member_photo where id = $1', [copied]);
  });

  it('a photo sealed for one person does not open as another', async () => {
    const [ready] = (await rows(child)).filter((r) => r.state === 'ready');
    const hh = owner.household_id;
    const scope = await withSystem(h.db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'household' }),
    );
    const { openBytes } = await import('@fdv/crypto');
    const sealed = ready?.sealed as Buffer;
    expect(
      Buffer.compare(
        openBytes(scope.key, sealed, memberPhotoBinding(hh, child, ready?.id as string)),
        SQUARE,
      ),
    ).toBe(0);
    expect(() =>
      openBytes(scope.key, sealed, memberPhotoBinding(hh, adult.member_id, ready?.id as string)),
    ).toThrow();
    expect(() =>
      openBytes(scope.key, sealed, memberPhotoBinding(randomUUID(), child, ready?.id as string)),
    ).toThrow();
    expect(() =>
      openBytes(scope.key, sealed, memberPhotoBinding(hh, child, randomUUID())),
    ).toThrow();
  });

  it('the database holds only ciphertext: no JPEG header, EXIF or GPS', async () => {
    // One on its way, and the rest made: every byte the table holds, and
    // every file in the vault, looked through.
    expect((await put(owner, teen.member_id)).statusCode).toBe(202);
    const { rows: all } = await admin.query<{ blob: Buffer }>(
      `select coalesce(sealed, ''::bytea) || coalesce(source_key_wrapped, ''::bytea)
              || convert_to(coalesce(crop::text, '') || coalesce(source_key, ''), 'UTF8') as blob
         from member_photo`,
    );
    expect(all.length).toBeGreaterThan(2);
    const audit = await admin.query<{ detail: unknown }>(
      "select detail from audit_event where action like 'member.photo%'",
    );
    const files: Buffer[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else files.push(await readFile(p));
      }
    };
    await walk(h.vaultDir);
    for (const blob of [...all.map((r) => r.blob), ...files]) {
      expect(blob.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
      expect(blob.includes(Buffer.from('Exif'))).toBe(false);
      expect(blob.includes(Buffer.from(GPS))).toBe(false);
      expect(blob.includes(Buffer.from('IMG_2041'))).toBe(false);
    }
    for (const r of audit.rows) {
      expect(Object.keys(r.detail as object).filter((k) => k !== 'replaced')).toEqual([]);
    }
    await finish(teen.member_id);
  });

  it('the upload as sent is gone once the square exists, and once it is refused', async () => {
    // Sealed as it arrives, into the person's folder, and nowhere else.
    expect((await put(adult, child, [['file', PNG, 'photo.png', 'image/png']])).statusCode).toBe(
      202,
    );
    const [on] = (await rows(child)).filter((r) => r.state === 'processing');
    expect(await incoming(child)).toEqual([`${on?.id}.enc`]);
    const { sent } = await finish(child);
    expect(Buffer.compare(sent, PNG)).toBe(0);
    // The square exists: the row holds no way to the upload, and the vault no upload.
    const [ready] = (await rows(child)).filter((r) => r.state === 'ready');
    expect(ready).toMatchObject({ id: on?.id, source_key: null, source_key_wrapped: null });
    expect(await incoming(child)).toEqual([]);
    // Refused, it is gone at once: nothing in the folder, no row.
    const r = await put(adult, child, [['file', Buffer.from('%PDF-1.4\n%%EOF\n')]]);
    expect(r.statusCode).toBe(415);
    expect(await incoming(child)).toEqual([]);
    expect((await rows(child)).map((x) => x.state)).toEqual(['ready']);
  });

  it('a new photo while one is being made keeps only the newest', async () => {
    const first = await put(owner, child);
    expect(first.statusCode).toBe(202);
    const [a] = (await rows(child)).filter((r) => r.state === 'processing');
    const second = await put(owner, child, [['file', PNG, 'b.png', 'image/png']]);
    expect(second.statusCode).toBe(202);
    const unfinished = (await rows(child)).filter((r) => r.state !== 'ready');
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.id).not.toBe(a?.id);
    // The first's upload went with it; the second's is the only one.
    expect(await incoming(child)).toEqual([`${unfinished[0]?.id}.enc`]);
    const { sent } = await finish(child);
    expect(Buffer.compare(sent, PNG)).toBe(0);
    // And the person has one photo.
    expect((await rows(child)).map((r) => r.state)).toEqual(['ready']);
  });

  it('no photo in the capability document, the invitation preview, a share preview, email, push or the digest', async () => {
    const ids = (await admin.query<{ id: string }>('select id from member_photo')).rows.map(
      (r) => r.id,
    );
    expect(ids.length).toBeGreaterThan(0);
    const tell = (what: string, body: string) => {
      for (const id of ids) expect(body, what).not.toContain(id);
      expect(body, what).not.toMatch(/"photo"|photo_status|image\/jpeg/);
    };
    // The capability document says the vault has photos, and nothing of any.
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(caps.json<Capabilities>().features.member_photos).toBe(true);
    tell('capabilities', caps.body);
    // The child, invited to sign in: the page they open says nothing of it.
    const invited = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${child}/invite`,
      headers: h.as(owner),
      payload: { email: 'aisha@example.test', role: 'teen' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const preview = await h.app.inject({
      url: `/api/v1/invitations/${invited.json<{ link_token: string }>().link_token}`,
    });
    expect(preview.statusCode).toBe(200);
    tell('invitation preview', preview.body);
    // A link to one of the child's documents.
    const doc = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Swimming certificate', owner_member_id: child },
    });
    const form = new FormData();
    form.append('file', Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'), {
      filename: 'certificate.pdf',
      contentType: 'application/pdf',
    });
    const uploaded = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.json<{ id: string }>().id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const shared = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.json<{ id: string }>().id}/share`,
      headers: h.as(owner),
      payload: { recipient_label: 'the swimming club' },
    });
    expect(shared.statusCode, shared.body).toBe(201);
    const shown = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/preview',
      payload: { token: shared.json<{ link_token: string }>().link_token },
    });
    expect(shown.json<ShareLinkPreview>().household_name).toBeTruthy();
    tell('share preview', shown.body);
    // What the API asked the worker to send: alerts, pushes.
    for (const j of h.jobs.filter((x) => x.name !== 'member.photo')) {
      tell(j.name, JSON.stringify(j.data));
    }
    // And the worker's email, push and digest never read the table.
    const worker = fileURLToPath(new URL('../../../worker/src/jobs/', import.meta.url));
    for (const f of ['notify.ts', 'push.ts', 'alerts.ts', 'reminders.ts']) {
      expect(await readFile(path.join(worker, f), 'utf8'), f).not.toMatch(/member_photo|photo/i);
    }
  });

  it('relationship, photo_status and can_change_photo reach only those allowed', async () => {
    // Something on its way for the child, and for the teen.
    expect((await put(owner, child)).statusCode).toBe(202);
    expect((await put(teen, teen.member_id)).statusCode).toBe(202);
    const seen = async (as: Tokens) => {
      const all = await members(as);
      const of = (id: string) => all.find((m) => m.id === id) as Member;
      return {
        childRelationship: of(child).relationship,
        ownRelationship: of(as.member_id).relationship,
        childStatus: of(child).photo_status,
        teenStatus: of(teen.member_id).photo_status,
        can: Object.fromEntries(
          [owner, adult, teen, viewer].map((t) => [t.member_id, of(t.member_id).can_change_photo]),
        ),
        canChild: of(child).can_change_photo,
      };
    };
    const [o, a, t, v] = [owner, adult, teen, viewer].map((x) => x.member_id);
    expect(await seen(owner)).toEqual({
      childRelationship: 'Daughter',
      ownRelationship: null,
      childStatus: 'processing',
      teenStatus: 'processing',
      can: { [o as string]: true, [a as string]: true, [t as string]: true, [v as string]: true },
      canChild: true,
    });
    expect(await seen(adult)).toEqual({
      childRelationship: 'Daughter',
      ownRelationship: null,
      childStatus: 'processing',
      teenStatus: null,
      can: {
        [o as string]: false,
        [a as string]: true,
        [t as string]: false,
        [v as string]: false,
      },
      canChild: true,
    });
    expect(await seen(teen)).toEqual({
      childRelationship: 'Daughter',
      ownRelationship: null,
      childStatus: null,
      teenStatus: 'processing',
      can: {
        [o as string]: false,
        [a as string]: false,
        [t as string]: true,
        [v as string]: false,
      },
      canChild: false,
    });
    // A viewer: their own relationship, nobody else's; no status; no photo to change.
    expect(await seen(viewer)).toEqual({
      childRelationship: null,
      ownRelationship: 'Our accountant',
      childStatus: null,
      teenStatus: null,
      can: {
        [o as string]: false,
        [a as string]: false,
        [t as string]: false,
        [v as string]: false,
      },
      canChild: false,
    });
    // A refusal the worker made is told the same way.
    await admin.query(
      `update member_photo set state = 'failed', source_key = null, source_vault_id = null,
              source_key_wrapped = null where member_id = $1 and state = 'processing'`,
      [child],
    );
    expect((await personAs(owner, child)).photo_status).toBe('failed');
    expect((await personAs(teen, child)).photo_status).toBeNull();
  });

  it("an address in capitals files, seals and answers by the person's own id", async () => {
    // The 5.17c review: the upload's key, its seal, the lock, the job and
    // the answer were the address's spelling, so a PUT in capitals made a
    // photo that never opened, and answered 404 after the work was done.
    const CHILD = child.toUpperCase();
    const res = await put(owner, CHILD);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json<Member>()).toMatchObject({ id: child, photo_status: 'processing' });
    const [on] = (await rows(child)).filter((r) => r.state === 'processing');
    expect(h.jobs.filter((j) => j.name === 'member.photo').at(-1)?.data).toEqual({
      household_id: owner.household_id,
      member_id: child,
      photo_id: on?.id,
    });
    // Filed under the person's own folder, as the database spells it.
    expect(await incoming(child)).toContain(`${on?.id}.enc`);
    // The worker opens the upload by the person's own id, and seals by it.
    const { id } = await finish(child);
    // It opens, however the address spells the ids; nothing is logged as
    // unreadable, which is kept for a seal moved or altered.
    logged.length = 0;
    for (const [as, m, ph] of [
      [owner, child, id],
      [teen, CHILD, id.toUpperCase()],
      [adult, CHILD, id],
    ] as const) {
      const got = await fetchPhoto(as, m, ph);
      expect(got.statusCode, `${m} ${ph}`).toBe(200);
      expect(Buffer.compare(got.rawPayload, SQUARE)).toBe(0);
    }
    expect(logged.some((l) => l.includes('photo_unreadable'))).toBe(false);
    // A viewer's own, in capitals, is theirs; somebody else's is not.
    expect((await put(owner, viewer.member_id)).statusCode).toBe(202);
    const mine = await finish(viewer.member_id);
    const upper = viewer.member_id.toUpperCase();
    expect((await fetchPhoto(viewer, upper, mine.id.toUpperCase())).statusCode).toBe(200);
    expect((await fetchPhoto(viewer, CHILD, id)).statusCode).toBe(404);
    // Taken away in capitals: the log's line is the person's own.
    expect((await remove(viewer, upper)).statusCode).toBe(204);
    expect(await rows(viewer.member_id)).toEqual([]);
    const said = await admin.query<{ object_id: string }>(
      "select object_id from audit_event where action = 'member.photo_removed' order by id desc limit 1",
    );
    expect(said.rows[0]?.object_id).toBe(viewer.member_id);
  });

  it('a route given an upper-case id writes an audit row that still verifies', async () => {
    // The 5.17c review: appendAudit hashed the id as given, and the table
    // keeps a uuid in lower case, so the chain read as tampered with for
    // ever after. The sessions route, from another device of Vic's…
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'vic@example.test', password: 'another correct horse' },
      remoteAddress: '10.9.0.17',
    });
    expect(again.statusCode, again.body).toBe(200);
    const sessions = (
      await h.app.inject({ url: '/api/v1/auth/sessions', headers: h.as(viewer) })
    ).json<{ items: Array<{ id: string; current: boolean }> }>().items;
    const other = sessions.find((s) => !s.current) as { id: string };
    const ended = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${other.id.toUpperCase()}`,
      headers: h.as(viewer),
    });
    expect(ended.statusCode, ended.body).toBe(204);
    // …and a photo route: a photo put and taken away in capitals.
    expect((await put(owner, adult.member_id.toUpperCase())).statusCode).toBe(202);
    await finish(adult.member_id);
    expect((await remove(owner, adult.member_id.toUpperCase())).statusCode).toBe(204);
    const written = await admin.query<{ object_id: string; action: string }>(
      `select object_id, action from audit_event
        where household_id = $1 and action in ('auth.session_revoked', 'member.photo_removed')
        order by id desc limit 2`,
      [owner.household_id],
    );
    expect(written.rows).toEqual([
      { object_id: adult.member_id, action: 'member.photo_removed' },
      { object_id: other.id, action: 'auth.session_revoked' },
    ]);
    // The whole chain still verifies.
    const result = await withSystem(h.db, owner.household_id, (trx) =>
      verifyAuditChain(trx, owner.household_id),
    );
    expect(result).toMatchObject({ ok: true });
  });

  describe('as the application role, past the application (0040)', () => {
    /** A query as the vault's own role would run it, saying who is asking, with no WHERE of ours. */
    const asCaller = async (settings: Record<string, string>, query: string) => {
      const pool = createPool(h.appUrl, 1);
      const c = await pool.connect();
      try {
        await c.query('begin');
        for (const [k, v] of Object.entries({
          'app.household_id': owner.household_id,
          ...settings,
        })) {
          await c.query('select set_config($1, $2, true)', [k, v]);
        }
        const { rows: r } = await c.query<Record<string, unknown>>(query);
        await c.query('commit');
        return r;
      } finally {
        c.release();
        await pool.end();
      }
    };
    const account = (who: Tokens, role: string) => ({
      'app.actor': 'account',
      'app.member_id': who.member_id,
      'app.role': role,
    });

    it("a viewer's query with no WHERE clause returns only their own photo row", async () => {
      expect((await put(owner, viewer.member_id)).statusCode).toBe(202);
      await finish(viewer.member_id);
      const theirs = await asCaller(
        account(viewer, 'viewer'),
        'select member_id from member_photo',
      );
      expect(theirs).toEqual([{ member_id: viewer.member_id }]);
      // The family's, every one.
      const all = await asCaller(
        account(teen, 'teen'),
        'select distinct member_id from member_photo',
      );
      expect(all.length).toBeGreaterThan(3);
    });

    it('a link, upload or anonymous caller reads none', async () => {
      for (const actor of ['link', 'upload', 'anonymous', '']) {
        const got = await asCaller(
          {
            'app.actor': actor,
            'app.share_id': randomUUID(),
            'app.upload_request_id': randomUUID(),
          },
          'select count(*)::int as n from member_photo',
        );
        expect(got, actor).toEqual([{ n: 0 }]);
      }
    });

    it('a photo whose person the reader cannot see is not seen either', async () => {
      const [ready] = (await rows(child)).filter((r) => r.state === 'ready');
      // As 5.32 will narrow who a viewer sees: here, a rule hides the child.
      await admin.query(
        `create policy test_hides_the_child on member as restrictive using (id <> '${child}')`,
      );
      try {
        const byPerson = await asCaller(
          account(owner, 'owner'),
          `select count(*)::int as n from member_photo where member_id = '${child}'`,
        );
        const byId = await asCaller(
          account(owner, 'owner'),
          `select count(*)::int as n from member_photo where id = '${ready?.id}'`,
        );
        expect([byPerson, byId]).toEqual([[{ n: 0 }], [{ n: 0 }]]);
        // And through the API: the same as no photo.
        const r = await fetchPhoto(owner, child, ready?.id as string);
        expect(r.statusCode).toBe(404);
        expect((await put(owner, child)).statusCode).toBe(404);
      } finally {
        await admin.query('drop policy test_hides_the_child on member');
      }
      expect((await fetchPhoto(owner, child, ready?.id as string)).statusCode).toBe(200);
    });
  });
});

describe('the crop field', () => {
  it("a crop at the picture's edge a ten-thousandth over it, from rounding, is the edge", () => {
    // What the web sent for an 800 by 600 picture at zoom 1.6, pushed right,
    // before its rounding was mended (the 5.17c review): refused, then.
    const crop = parseCrop(JSON.stringify({ x: 0.5313, y: 0.1875, w: 0.4688, h: 0.625 }));
    expect(crop?.w).toBe(0.4688);
    expect(crop?.x).toBeCloseTo(0.5312, 12);
    expect((crop?.x ?? 0) + (crop?.w ?? 0)).toBeLessThanOrEqual(1 + 1e-12);
    // A crop that is really outside is still refused.
    for (const outside of [
      { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.52, w: 0.5, h: 0.5 },
    ]) {
      expect(() => parseCrop(JSON.stringify(outside)), JSON.stringify(outside)).toThrow(
        'must be inside it',
      );
    }
  });
});
