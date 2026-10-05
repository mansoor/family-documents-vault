import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  IDENTITY_TOO_LONG,
  shareEndWords,
  type ActivityLine,
  type IdentityAudienceView,
  type IdentityReveal,
  type IdentityView,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, Tokens } from '../auth/service.js';
import { codeFor } from '../auth/totp.js';
import { createHarness, mailSent, TEST_MASTER, type Harness } from '../test-harness.js';
import { IdentityService } from './identity.js';

/**
 * People's identity details, sealed (5.26): who reads and writes which
 * part, masked until shown, the household's audience (A34), and what the
 * activity log says of it (A38). The privacy wall's own cases are in
 * privacy-wall.test.ts.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = Awaited<ReturnType<Harness['app']['inject']>>;
const error = (r: Res) =>
  json<{ error: { code: string; message: string; action?: string; detail?: string } }>(r).error;

/** Values nobody else would write: none may appear anywhere but a reveal. */
const PASSPORT = 'K7Q2PASS9981';
const LICENCE = 'DRVZQ55130X';
const SECRET_PIN = 'pin-quillon-4471';
const ONLY_ME_NUMBER = 'ONLYME-TAX-77310';
const VALUES = [PASSPORT, LICENCE, SECRET_PIN, ONLY_ME_NUMBER, 'Zygmunt', 'Quillonshire'];

describe.skipIf(!testAdminUrl())("people's identity details (5.26)", () => {
  let h: Harness;
  let owner: Tokens;
  let sara: Tokens;
  let adam: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  /** A second owner, with a password alone. */
  let second: Tokens;
  let child: string;
  let secret = '';

  const get = (who: Tokens, id: string) =>
    h.app.inject({ url: `/api/v1/members/${id}/identity`, headers: h.as(who) });
  const put = (who: Tokens, id: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${id}/identity`,
      headers: h.as(who),
      payload,
    });
  const reveal = (who: Tokens, id: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${id}/identity/reveal`,
      headers: h.as(who),
      payload,
    });
  const audience = (who: Tokens) =>
    h.app.inject({ url: '/api/v1/household/identity-audience', headers: h.as(who) });
  const setAudience = (who: Tokens, to: string) =>
    h.app.inject({
      method: 'PUT',
      url: '/api/v1/household/identity-audience',
      headers: h.as(who),
      payload: { audience: to },
    });
  const stepUp = (who: Tokens, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: h.as(who), payload });
  const activity = async (who: Tokens) =>
    json<{ items: ActivityLine[] }>(
      await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(who) }),
    ).items.map((l) => l.text);
  const accountOf = async (who: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(who) }))
      .account_id;
  const admin = () => createPool(h.adminUrl, 2);
  const versions = async (who: Tokens, id: string) =>
    json<IdentityView>(await get(who, id)).versions;
  /** The owner's session, just now confirmed with a code. */
  const ownerByCode = async () =>
    expect((await stepUp(owner, { code: codeFor(secret) })).statusCode).toBe(200);
  const deadlocks = async (pool: ReturnType<typeof createPool>) =>
    (
      await pool.query<{ n: number }>(
        'select deadlocks::int as n from pg_stat_database where datname = $1',
        [new URL(h.adminUrl).pathname.slice(1)],
      )
    ).rows[0]?.n as number;
  const waiting = async (pool: ReturnType<typeof createPool>, n: number) => {
    for (let i = 0; i < 200; i += 1) {
      const r = await pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = $1 and wait_event_type = 'Lock'`,
        [new URL(h.adminUrl).pathname.slice(1)],
      );
      if ((r.rows[0]?.n ?? 0) >= n) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`fewer than ${n} statements waiting on a lock`);
  };
  /** `first`, then `second`, each on its own connection, both queued behind a row held from outside. */
  const race = async <A, B>(
    hold: string,
    args: unknown[],
    first: () => Promise<A>,
    second: () => Promise<B>,
  ) => {
    const pool = admin();
    const holder = await pool.connect();
    const before = await deadlocks(pool);
    try {
      await holder.query('begin');
      await holder.query(hold, args);
      const a = first();
      await waiting(pool, 1);
      const b = second();
      await waiting(pool, 2);
      await holder.query('rollback');
      const both = await Promise.all([a, b]);
      await new Promise((res) => setTimeout(res, 1500));
      expect(await deadlocks(pool)).toBe(before);
      return both;
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await pool.end();
    }
  };

  const saraShared = {
    given_name: 'Sara',
    family_name: 'Zygmunt',
    place_of_birth: 'Quillonshire',
    country_of_birth: 'gb',
    nationalities: ['GB', 'pk'],
    emails: [{ id: 'e1', label: 'Home', value: 'sara.home@example.test' }],
    ids: [
      { id: 'p1', kind: 'passport', number: PASSPORT, issuer: 'HMPO', expires_on: '2031-03-01' },
      { id: 'd1', kind: 'driving_licence', number: LICENCE },
    ],
    custom: [
      { id: 'c1', label: 'Locker code', value: SECRET_PIN, hidden: true },
      { id: 'c2', label: 'Shoe size', value: '6' },
    ],
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    sara = await h.join(owner, { name: 'Sara', email: 'sara-526@example.test', role: 'adult' });
    adam = await h.join(owner, { name: 'Adam', email: 'adam-526@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tariq', email: 'tariq-526@example.test', role: 'teen' });
    viewer = await h.join(owner, {
      name: 'The Accountant',
      email: 'acc-526@example.test',
      role: 'viewer',
    });
    second = await h.join(owner, {
      name: 'Second Owner',
      email: 'second-owner-526@example.test',
      role: 'owner',
    });
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Aisha' },
    });
    child = json<{ id: string }>(added).id;
    // Two-step sign-in for the owner, for the powers that ask for it (A54).
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    secret = json<{ secret: string }>(enrol).secret;
    const confirmed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    expect(confirmed.statusCode).toBe(204);
  }, 120_000);
  afterAll(() => h.close());

  it('the person writes both parts; an owner reads the shared part masked and never Only me; each part has its version', async () => {
    const empty = json<IdentityView>(await get(sara, sara.member_id));
    expect(empty).toMatchObject({
      member_id: sara.member_id,
      audience: 'owners_and_self',
      can_edit: { shared: true, only_me: true },
      versions: { shared: 0, only_me: 0 },
      shared: { fields: {}, masked: [], filled: [], version: 0, updated_at: null },
      only_me: { fields: {}, version: 0 },
    });

    const made = await put(sara, sara.member_id, {
      part: 'shared',
      version: 0,
      fields: saraShared,
    });
    expect(made.statusCode, made.body).toBe(200);
    const view = json<IdentityView>(made);
    expect(view.versions).toEqual({ shared: 1, only_me: 0 });
    // Masked: ID numbers and hidden custom fields; the rest as written.
    expect(view.shared.masked.sort()).toEqual(['custom.c1', 'ids.d1', 'ids.p1']);
    expect(view.shared.fields).toMatchObject({
      given_name: 'Sara',
      country_of_birth: 'GB',
      nationalities: ['GB', 'PK'],
      ids: [
        { id: 'p1', kind: 'passport', issuer: 'HMPO', expires_on: '2031-03-01' },
        { id: 'd1', kind: 'driving_licence' },
      ],
      custom: [
        { id: 'c1', label: 'Locker code', hidden: true },
        { id: 'c2', label: 'Shoe size', value: '6' },
      ],
    });
    // Left out, not null (the 5.26 review): sent back, it is kept.
    for (const i of view.shared.fields.ids ?? []) expect(i).not.toHaveProperty('number');
    expect(view.shared.fields.custom?.[0]).not.toHaveProperty('value');
    const shownBack = json<IdentityView>(await get(sara, sara.member_id));
    const echoed = await put(sara, sara.member_id, {
      part: 'shared',
      version: shownBack.versions.shared,
      fields: shownBack.shared.fields,
    });
    expect(echoed.statusCode, echoed.body).toBe(200);
    // Nothing changed: no new version, and every masked value still there.
    expect(json<IdentityView>(echoed).versions).toEqual({ shared: 1, only_me: 0 });
    expect(json<IdentityView>(echoed).shared.masked.sort()).toEqual([
      'custom.c1',
      'ids.d1',
      'ids.p1',
    ]);
    expect(view.shared.filled.sort()).toEqual(
      [
        'given_name',
        'family_name',
        'place_of_birth',
        'country_of_birth',
        'nationalities',
        'emails.e1',
        'ids.p1',
        'ids.d1',
        'custom.c1',
        'custom.c2',
      ].sort(),
    );
    expect(made.body).not.toContain(PASSPORT);
    expect(made.body).not.toContain(SECRET_PIN);

    const onlyMe = await put(sara, sara.member_id, {
      part: 'only_me',
      version: 0,
      fields: { ids: [{ id: 't1', kind: 'tax_id', number: ONLY_ME_NUMBER }], notes: 'mine' },
    });
    expect(onlyMe.statusCode, onlyMe.body).toBe(200);
    expect(json<IdentityView>(onlyMe).versions).toEqual({ shared: 1, only_me: 1 });

    // The owner: the shared part, masked; nothing of Only me, not its version.
    const seen = await get(owner, sara.member_id);
    expect(seen.statusCode).toBe(200);
    const asOwner = json<IdentityView>(seen);
    expect(asOwner).toMatchObject({
      can_edit: { shared: true, only_me: false },
      versions: { shared: 1, only_me: null },
      only_me: null,
    });
    expect(asOwner.shared.fields.given_name).toBe('Sara');
    for (const v of [PASSPORT, SECRET_PIN, ONLY_ME_NUMBER, 'mine', 't1', 'tax_id']) {
      expect(seen.body, v).not.toContain(v);
    }
    // Stored sealed: no value is in the database as words.
    const pool = admin();
    try {
      const { rows } = await pool.query<{ sealed: Buffer; filled: string[]; part: string }>(
        'select sealed, filled, part from member_identity where member_id = $1',
        [sara.member_id],
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        for (const v of [PASSPORT, SECRET_PIN, ONLY_ME_NUMBER, 'Zygmunt']) {
          expect(r.sealed.includes(Buffer.from(v)), v).toBe(false);
        }
      }
      // The shared part under the household's identity key, minted on its
      // first write; Only me under Sara's own member key.
      const keys = await pool.query<{ part: string; kind: string; member_id: string | null }>(
        `select i.part, k.kind::text as kind, k.member_id from member_identity i
           join scope_key k on k.id = i.wrapped_by_scope where i.member_id = $1 order by 1`,
        [sara.member_id],
      );
      expect(keys.rows).toEqual([
        { part: 'only_me', kind: 'member', member_id: sara.member_id },
        { part: 'shared', kind: 'identity', member_id: null },
      ]);
    } finally {
      await pool.end();
    }
  });

  it('who writes what: the person both parts, an owner the shared part of anybody, nobody else', async () => {
    // An owner, a person with no sign-in: the shared part only.
    const forChild = await put(owner, child, {
      part: 'shared',
      version: 0,
      fields: {
        given_name: 'Aisha',
        ids: [{ id: 'b1', kind: 'other', label: 'Birth certificate' }],
      },
    });
    expect(forChild.statusCode, forChild.body).toBe(200);
    // Nobody else's Only me part is there for anybody, an owner included.
    expect((await put(owner, child, { part: 'only_me', version: 0, fields: {} })).statusCode).toBe(
      404,
    );
    expect(
      (await put(owner, sara.member_id, { part: 'only_me', version: 0, fields: { notes: 'x' } }))
        .statusCode,
    ).toBe(404);
    // An adult reads nobody else's record yet (owners and each person): 404.
    expect(
      (await put(adam, sara.member_id, { part: 'shared', version: 1, fields: {} })).statusCode,
    ).toBe(404);
    // A teen writes their own, both parts.
    expect(
      (await put(teen, teen.member_id, { part: 'only_me', version: 0, fields: { notes: 'mine' } }))
        .statusCode,
    ).toBe(200);
    // A viewer reads their own record, and changes nothing.
    expect((await get(viewer, viewer.member_id)).statusCode).toBe(200);
    const refused = await put(viewer, viewer.member_id, {
      part: 'shared',
      version: 0,
      fields: { given_name: 'Acc' },
    });
    expect(refused.statusCode).toBe(403);
    expect(error(refused).code).toBe('forbidden');
    // What is sent is checked: the catalogue, and nothing else.
    for (const fields of [
      { blood_type: 'O+' },
      { country_of_birth: 'Britain' },
      {
        ids: [
          { id: 'x', kind: 'passport' },
          { id: 'x', kind: 'tax_id' },
        ],
      },
      { ids: [{ id: 'bad id!', kind: 'passport' }] },
      { ids: [{ id: 'y', kind: 'library_card' }] },
      { sex: 'female' },
      { ids: [{ id: 'z', kind: 'passport', expires_on: '2031-02-30' }] },
    ]) {
      const r = await put(teen, teen.member_id, { part: 'shared', version: 0, fields });
      expect(r.statusCode, JSON.stringify(fields)).toBe(422);
    }
  });

  it('a stale version is 409; two PUTs of the same part at once: one is made, the other is 409', async () => {
    const now = await versions(sara, sara.member_id);
    const stale = await put(sara, sara.member_id, {
      part: 'shared',
      version: now.shared - 1,
      fields: { ...saraShared, given_name: 'Sarah' },
    });
    expect(stale.statusCode).toBe(409);
    expect(error(stale).code).toBe('conflict');
    expect(JSON.parse(error(stale).detail ?? '{}')).toEqual({
      part: 'shared',
      version: now.shared,
    });
    expect(await versions(sara, sara.member_id)).toEqual(now);

    // Both made from the same version, queued behind the part held from outside.
    const [first, second] = await race(
      "select 1 from member_identity where member_id = $1 and part = 'shared' for update",
      [sara.member_id],
      () =>
        put(sara, sara.member_id, {
          part: 'shared',
          version: now.shared,
          fields: { ...saraShared, middle_name: 'First' },
        }),
      () =>
        put(owner, sara.member_id, {
          part: 'shared',
          version: now.shared,
          fields: { ...saraShared, middle_name: 'Second' },
        }),
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(409);
    const after = json<IdentityView>(await get(sara, sara.member_id));
    expect(after.shared.fields.middle_name).toBe('First');
    expect(after.versions.shared).toBe(now.shared + 1);

    // Two first writes of a part nobody has written: one is made.
    const [a, b] = await Promise.all([
      put(adam, adam.member_id, { part: 'shared', version: 0, fields: { given_name: 'A' } }),
      put(owner, adam.member_id, { part: 'shared', version: 0, fields: { given_name: 'B' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(json<IdentityView>(await get(adam, adam.member_id)).versions.shared).toBe(1);
  });

  it('what the writer was shown masked, or may not see, is kept; nothing different is no change', async () => {
    // Sara links her passport to her own Only me scan, which nobody else sees.
    const scan = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(sara),
      payload: { title: 'Passport scan', visibility: 'private', owner_member_id: sara.member_id },
    });
    expect(scan.statusCode, scan.body).toBe(201);
    const scanId = json<{ id: string }>(scan).id;
    const mine = json<IdentityView>(await get(sara, sara.member_id));
    const linked = await put(sara, sara.member_id, {
      part: 'shared',
      version: mine.versions.shared,
      fields: {
        ...saraShared,
        middle_name: 'First',
        ids: saraShared.ids.map((i) => (i.id === 'p1' ? { ...i, document_id: scanId } : i)),
      },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(json<IdentityView>(linked).shared.fields.ids?.[0]?.document_id).toBe(scanId);

    // The owner is shown neither the numbers nor the link, and writes back
    // what they were shown, with a change of their own.
    const shown = json<IdentityView>(await get(owner, sara.member_id));
    expect(shown.shared.fields.ids?.[0]).not.toHaveProperty('document_id');
    const fields = JSON.parse(JSON.stringify(shown.shared.fields)) as typeof saraShared;
    // A client leaves out what it was given masked.
    for (const i of fields.ids) delete (i as { number?: unknown }).number;
    for (const c of fields.custom) if (c.hidden) delete (c as { value?: unknown }).value;
    const lines = (await activity(owner)).length;
    const edited = await put(owner, sara.member_id, {
      part: 'shared',
      version: shown.versions.shared,
      fields: { ...fields, job_title: 'Engineer' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    // Sara's numbers, hidden field and link are as she left them.
    const asSara = json<IdentityView>(await get(sara, sara.member_id));
    expect(asSara.shared.fields.job_title).toBe('Engineer');
    expect(asSara.shared.fields.ids?.[0]?.document_id).toBe(scanId);
    expect(await stepUp(sara, { password: 'another correct horse' })).toMatchObject({
      statusCode: 200,
    });
    const values = json<IdentityReveal>(
      await reveal(sara, sara.member_id, { keys: ['ids.p1', 'ids.d1', 'custom.c1'] }),
    ).values;
    expect(values).toEqual({ 'ids.p1': PASSPORT, 'ids.d1': LICENCE, 'custom.c1': SECRET_PIN });
    // A link sent as null by somebody who may not see it stays.
    const again = json<IdentityView>(await get(owner, sara.member_id));
    const unlink = await put(owner, sara.member_id, {
      part: 'shared',
      version: again.versions.shared,
      fields: {
        ...fields,
        job_title: 'Engineer',
        ids: fields.ids.map((i) => ({ ...i, document_id: null })),
      },
    });
    expect(unlink.statusCode).toBe(200);
    expect(
      json<IdentityView>(await get(sara, sara.member_id)).shared.fields.ids?.[0]?.document_id,
    ).toBe(scanId);
    // Which changed nothing at all: no new version.
    const before = json<IdentityView>(await get(owner, sara.member_id)).versions.shared;
    expect(before).toBe(again.versions.shared);
    const same = await put(owner, sara.member_id, {
      part: 'shared',
      version: before,
      fields: { ...fields, job_title: 'Engineer' },
    });
    expect(json<IdentityView>(same).versions.shared).toBe(before);
    // The owner's one change, and Sara showing her own numbers: no more.
    expect((await activity(owner)).length).toBe(lines + 2);
    // A document the writer cannot see is not theirs to link.
    const refused = await put(owner, sara.member_id, {
      part: 'shared',
      version: before,
      fields: { ...fields, ids: [...fields.ids, { id: 'n1', kind: 'other', document_id: scanId }] },
    });
    expect(refused.statusCode).toBe(422);
  });

  it('a password-only owner cannot reveal; step-up by password is refused for it; a code opens it', async () => {
    const refused = await reveal(second, sara.member_id, { keys: ['ids.p1'] });
    expect(refused.statusCode).toBe(403);
    // In the words of what was asked (the 5.26 review).
    expect(error(refused)).toMatchObject({
      code: 'totp_required_for_owner',
      message: "Turn on two-step sign-in to see another person's identity numbers.",
    });
    expect(refused.body).not.toContain(PASSPORT);

    // The owner with two-step sign-in, after a password: still asked.
    expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
    const asked = await reveal(owner, sara.member_id, { keys: ['ids.p1'] });
    expect(asked.statusCode).toBe(403);
    expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'open_identity' });
    await ownerByCode();
    const shown = await reveal(owner, sara.member_id, {
      keys: ['ids.p1', 'ids.nope', 'given_name'],
    });
    expect(shown.statusCode, shown.body).toBe(200);
    // What is masked and named, nothing else.
    expect(json<IdentityReveal>(shown)).toEqual({ part: 'shared', values: { 'ids.p1': PASSPORT } });
    // Not anybody's Only me part, whatever an owner proves.
    expect(
      (await reveal(owner, sara.member_id, { part: 'only_me', keys: ['ids.t1'] })).statusCode,
    ).toBe(404);
    // Their own numbers: any credential, as an Only me document asks.
    expect((await reveal(owner, owner.member_id, { keys: ['ids.x'] })).statusCode).toBe(200);
  });

  it('revealing is audited by key, never by value; the person sees a line when somebody else shows their numbers (A38)', async () => {
    const pool = admin();
    try {
      const { rows } = await pool.query<{ action: string; detail: Record<string, unknown> }>(
        `select action, detail from audit_event
          where action = 'identity.revealed' and object_id = $1 order by id`,
        [sara.member_id],
      );
      expect(rows.map((r) => r.detail)).toContainEqual({ part: 'shared', keys: ['ids.p1'] });
    } finally {
      await pool.end();
    }
    // Sara sees the owner's reveal and her own; Adam, another adult, neither.
    const saraSees = await activity(sara);
    expect(saraSees).toContain('Owner showed one of Sara’s identity numbers');
    expect(saraSees).toContain('Sara showed 3 of their own identity numbers');
    for (const who of [adam, teen]) {
      expect((await activity(who)).filter((l) => /Sara/.test(l) && /identity/.test(l))).toEqual([]);
    }
  });

  it('a password-only owner is refused the identity-audience switch, and step-up by password is refused', async () => {
    const refused = await setAudience(second, 'adults');
    expect(refused.statusCode).toBe(403);
    expect(error(refused)).toMatchObject({
      code: 'totp_required_for_owner',
      message: 'Turn on two-step sign-in to change who can see identity details.',
    });
    // An owner with two-step sign-in, confirmed by password only: asked.
    expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
    const pool = admin();
    try {
      await pool.query(
        "update session set factor_verified_at = now() - interval '10 minutes' where household_id = $1",
        [owner.household_id],
      );
    } finally {
      await pool.end();
    }
    const asked = await setAudience(owner, 'adults');
    expect(asked.statusCode).toBe(403);
    expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'identity_audience' });
    // Anybody but an owner: refused, in the matrix's words.
    for (const who of [sara, teen, viewer]) {
      const r = await setAudience(who, 'family');
      expect(r.statusCode).toBe(403);
      expect(error(r).message).toBe('Only an owner can change who sees identity details.');
    }
    expect(json<IdentityAudienceView>(await audience(owner))).toMatchObject({
      audience: 'owners_and_self',
      pending: null,
    });
  });

  it('widening waits 72 hours and every adult is told; narrowing is immediate', async () => {
    const saraAccount = await accountOf(sara);
    const adamAccount = await accountOf(adam);
    // West of UTC: the day and the hour are the household's (the 5.26 review).
    const zone = 'America/Los_Angeles';
    const profile = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { timezone: zone },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    const since = h.jobs.length;
    await ownerByCode();
    const asked = await setAudience(owner, 'adults');
    expect(asked.statusCode, asked.body).toBe(200);
    const view = json<IdentityAudienceView>(asked);
    expect(view.audience).toBe('owners_and_self');
    expect(view.pending?.to).toBe('adults');
    const wait = Date.parse(view.pending?.notice_until as string) - Date.now();
    expect(wait).toBeGreaterThan(72 * 3600_000 - 60_000);
    expect(wait).toBeLessThanOrEqual(72 * 3600_000 + 1000);
    // Everybody with a sign-in is told (the 5.26 review): in the app, which
    // shows it waiting to each of them; and by the operator's mail server.
    // Not the owner asking. Their devices hear the word `notice` alone
    // (5.33, identity-notice.test.ts): nobody here has one.
    for (const who of [sara, adam, teen, viewer, second]) {
      expect(json<IdentityAudienceView>(await audience(who))).toMatchObject({
        audience: 'owners_and_self',
        pending: { to: 'adults' },
      });
    }
    const alerts = h.jobs
      .slice(since)
      .filter((j) => j.name === 'alert.send')
      .map((j) => j.data);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ email_only: true, via: 'operator' });
    expect([...(alerts[0]?.account_ids as string[])].sort()).toEqual(
      [
        saraAccount,
        adamAccount,
        await accountOf(teen),
        await accountOf(viewer),
        await accountOf(second),
      ].sort(),
    );
    expect(alerts[0]?.account_ids).not.toContain(await accountOf(owner));
    expect(h.jobs.slice(since).filter((j) => j.name === 'push.send')).toEqual([]);
    // From when, on the household's clock, with its zone named.
    const until = new Date(view.pending?.notice_until as string);
    expect(alerts[0]?.body).toContain(`From ${shareEndWords(until, zone)} (${zone}),`);
    // And the line about it, read by everybody told, says the same moment.
    const askedLine = `Owner asked to let all adults see identity details from ${shareEndWords(until, zone, { weekday: false })}`;
    for (const who of [owner, sara, teen]) expect(await activity(who)).toContain(askedLine);
    // Meanwhile Adam reads nobody's record but his own...
    expect((await get(adam, sara.member_id)).statusCode).toBe(404);
    expect((await get(adam, owner.member_id)).statusCode).toBe(404);
    // ...and asking again for the same does not start the clock again.
    await ownerByCode();
    const again = json<IdentityAudienceView>(await setAudience(owner, 'adults'));
    expect(again.pending?.notice_until).toBe(view.pending?.notice_until);
    expect(h.jobs.slice(since).filter((j) => j.name === 'alert.send')).toHaveLength(1);

    // 72 hours on, as the database's clock would have it.
    const pool = admin();
    try {
      await pool.query(
        `update notice_request set requested_at = requested_at - interval '73 hours',
                notice_until = notice_until - interval '73 hours'
          where household_id = $1 and completed_at is null and withdrawn_at is null`,
        [owner.household_id],
      );
      expect((await get(adam, sara.member_id)).statusCode).toBe(200);
      expect((await get(teen, sara.member_id)).statusCode).toBe(404);
      expect(json<IdentityAudienceView>(await audience(adam))).toMatchObject({
        audience: 'adults',
        pending: null,
      });
      // Adam may now read Sara's details, and show her numbers only with a
      // passkey or a code, as anybody showing another person's (the 5.26
      // review); he has neither.
      expect((await stepUp(adam, { password: 'another correct horse' })).statusCode).toBe(200);
      const hers = await reveal(adam, sara.member_id, { keys: ['ids.p1'] });
      expect(hers.statusCode).toBe(403);
      expect(error(hers)).toMatchObject({
        code: 'two_step_required',
        message: "Turn on two-step sign-in to see another person's identity numbers.",
      });
      expect(hers.body).not.toContain(PASSPORT);
      // His own, with the password he just gave.
      expect((await reveal(adam, adam.member_id, { keys: ['ids.x'] })).statusCode).toBe(200);

      // Adam's copy of everything, made while he could read them.
      await pool.query(
        'insert into export (household_id, requested_by, state) values ($1, $2, $3)',
        [owner.household_id, adamAccount, 'done'],
      );
      // Narrowing: at once — from the audience in effect, the widening whose
      // notice has run out though nothing has written it in yet — and
      // Adam's export ends with it.
      await ownerByCode();
      const narrowed = await setAudience(owner, 'owners_and_self');
      expect(narrowed.statusCode, narrowed.body).toBe(200);
      expect(json<IdentityAudienceView>(narrowed)).toMatchObject({
        audience: 'owners_and_self',
        pending: null,
      });
      expect((await get(adam, sara.member_id)).statusCode).toBe(404);
      const exports = await pool.query<{ expired: boolean }>(
        'select expires_at <= now() as expired from export where requested_by = $1',
        [adamAccount],
      );
      expect(exports.rows).toEqual([{ expired: true }]);
      // The widening that had run out was written in, then narrowed.
      const notices = await pool.query<{ completed: boolean; withdrawn: boolean }>(
        `select completed_at is not null as completed, withdrawn_at is not null as withdrawn
           from notice_request where household_id = $1`,
        [owner.household_id],
      );
      expect(notices.rows).toEqual([{ completed: true, withdrawn: false }]);
    } finally {
      await pool.end();
    }
    for (const who of [owner, adam, teen]) {
      expect(await activity(who)).toContain(
        'Owner made identity details visible to the owners and each person only',
      );
    }
  });

  it('a widening waiting is withdrawn by keeping things as they are, or replaced by another, each with its own 72 hours', async () => {
    await ownerByCode();
    const first = json<IdentityAudienceView>(await setAudience(owner, 'family'));
    expect(first.pending?.to).toBe('family');
    await ownerByCode();
    const kept = json<IdentityAudienceView>(await setAudience(owner, 'owners_and_self'));
    expect(kept).toMatchObject({ audience: 'owners_and_self', pending: null });
    expect(await activity(owner)).toContain(
      'Owner withdrew letting everyone in the family see identity details',
    );
    await ownerByCode();
    const adults = json<IdentityAudienceView>(await setAudience(owner, 'adults'));
    await ownerByCode();
    const family = json<IdentityAudienceView>(await setAudience(owner, 'family'));
    expect(family.pending?.to).toBe('family');
    expect(Date.parse(family.pending?.notice_until as string)).toBeGreaterThanOrEqual(
      Date.parse(adults.pending?.notice_until as string),
    );
    const pool = admin();
    try {
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from notice_request
          where household_id = $1 and completed_at is null and withdrawn_at is null`,
        [owner.household_id],
      );
      expect(rows[0]?.n).toBe(1);
    } finally {
      await pool.end();
    }
    await ownerByCode();
    expect(
      json<IdentityAudienceView>(await setAudience(owner, 'owners_and_self')).pending,
    ).toBeNull();
  });

  it('a widening and a narrowing at once: each after the other, never both, and no deadlock', async () => {
    const pool = admin();
    try {
      // All adults read them now.
      await pool.query("update household set identity_audience = 'adults' where id = $1", [
        owner.household_id,
      ]);
    } finally {
      await pool.end();
    }
    await ownerByCode();
    const [widened, narrowed] = await race(
      'select 1 from household where id = $1 for update',
      [owner.household_id],
      () => setAudience(owner, 'family'),
      () => setAudience(owner, 'owners_and_self'),
    );
    expect(widened.statusCode, widened.body).toBe(200);
    expect(json<IdentityAudienceView>(widened)).toMatchObject({
      audience: 'adults',
      pending: { to: 'family' },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    // The narrowing came second: the widening it found waiting is withdrawn.
    expect(json<IdentityAudienceView>(await audience(owner))).toMatchObject({
      audience: 'owners_and_self',
      pending: null,
    });
  });

  it('a widening is refused while anybody with a sign-in, of any role, cannot sign in to be told', async () => {
    const pool = admin();
    // A teen is told too (the 5.26 review), and a switched-off one is
    // reached by no mail and cannot sign in to mark anything Only me.
    for (const [who, name] of [
      [teen, 'Tariq'],
      [adam, 'Adam'],
      [viewer, 'The Accountant'],
    ] as const) {
      const account = await accountOf(who);
      try {
        await pool.query('update account set disabled_at = now() where id = $1', [account]);
        await ownerByCode();
        const refused = await setAudience(owner, 'adults');
        expect(refused.statusCode, name).toBe(409);
        expect(error(refused)).toMatchObject({ code: 'member_cannot_be_told' });
        expect(error(refused).message).toMatch(new RegExp(`^${name} cannot sign in just now`));
        expect(json<IdentityAudienceView>(await audience(owner)).pending).toBeNull();
        // Narrowing never waits for anybody.
        expect((await setAudience(owner, 'owners_and_self')).statusCode).toBe(200);
      } finally {
        await pool.query('update account set disabled_at = null where id = $1', [account]);
      }
    }
    await pool.end();
  });

  it('a widening whose mail cannot be queued is not asked: nothing waits, and asking again tells everybody (the 5.26 review)', async () => {
    const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
    const p: Principal = {
      accountId: await accountOf(owner),
      sessionId: '00000000-0000-4000-8000-000000000000',
      householdId: owner.household_id,
      memberId: owner.member_id,
      role: 'owner',
      seesAdults: true,
    };
    const waitingNotices = async () => {
      const pool = admin();
      try {
        return (
          await pool.query<{ n: number }>(
            `select count(*)::int as n from notice_request
              where household_id = $1 and completed_at is null and withdrawn_at is null`,
            [owner.household_id],
          )
        ).rows[0]?.n;
      } finally {
        await pool.end();
      }
    };
    const down = new IdentityService(
      h.db,
      keys,
      async () => {
        throw new Error('the queue is down');
      },
      true,
    );
    await expect(down.setAudience(p, 'family', { ip: null })).rejects.toThrow(/queue is down/);
    expect(await waitingNotices()).toBe(0);
    expect(json<IdentityAudienceView>(await audience(owner)).pending).toBeNull();
    // Asked again, with the queue back: asked, and everybody is told.
    const sent: AlertRequest[] = [];
    const up = new IdentityService(h.db, keys, async (a) => void sent.push(a), true);
    expect((await up.setAudience(p, 'family', { ip: null })).pending?.to).toBe('family');
    expect(sent).toHaveLength(1);
    expect(await waitingNotices()).toBe(1);
    expect((await up.setAudience(p, 'owners_and_self', { ip: null })).pending).toBeNull();
  });

  it('a part too big to keep is refused as too long, never failed (the 5.26 review)', async () => {
    const before = await versions(teen, teen.member_id);
    for (const [n, ch] of [
      [40, 'ب'],
      [11, '\u0001'],
    ] as const) {
      const r = await put(teen, teen.member_id, {
        part: 'only_me',
        version: before.only_me,
        fields: {
          custom: Array.from({ length: n }, (_, i) => ({
            id: `c${i}`,
            label: 'x',
            value: ch.repeat(2000),
          })),
        },
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(error(r)).toMatchObject({ code: 'validation_failed', message: IDENTITY_TOO_LONG });
    }
    expect(await versions(teen, teen.member_id)).toEqual(before);
  });

  it("the audience switch and somebody else's line in the activity log at once: no deadlock (the 5.26 review)", async () => {
    await ownerByCode();
    const v = json<IdentityView>(await get(sara, sara.member_id)).versions.shared;
    const pool = admin();
    const holder = await pool.connect();
    const before = await deadlocks(pool);
    try {
      await holder.query('begin');
      // The log, held from outside: both requests below queue for it.
      await holder.query("select pg_advisory_xact_lock(hashtext('audit:' || $1::uuid::text))", [
        owner.household_id,
      ]);
      // Sara's change, waiting to write its line...
      const line = put(sara, sara.member_id, {
        part: 'shared',
        version: v,
        fields: { ...saraShared, title: 'Dr' },
      });
      await waiting(pool, 1);
      // ...and the owner's switch, the household held, waiting behind it.
      const switched = setAudience(owner, 'adults');
      await waiting(pool, 2);
      await holder.query('rollback');
      const [changed, asked] = await Promise.all([line, switched]);
      expect(changed.statusCode, changed.body).toBe(200);
      expect(asked.statusCode, asked.body).toBe(200);
      await new Promise((res) => setTimeout(res, 1500));
      expect(await deadlocks(pool)).toBe(before);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await pool.end();
    }
    await ownerByCode();
    expect(
      json<IdentityAudienceView>(await setAudience(owner, 'owners_and_self')).pending,
    ).toBeNull();
  });

  it('the database holds it: nobody widens before the notice runs out, a notice ends once, a viewer writes nothing', async () => {
    const pool = createPool(h.appUrl, 1);
    const as = async (
      who: { actor: string; role?: string; member?: string; account?: string },
      text: string,
      args: unknown[] = [],
    ): Promise<number | string> => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true),
                  set_config('app.member_id', $3, true), set_config('app.role', $4, true),
                  set_config('app.account_id', $5, true)`,
          [owner.household_id, who.actor, who.member ?? '', who.role ?? '', who.account ?? ''],
        );
        const r = await c.query(text, args);
        return r.rowCount ?? 0;
      } catch (err) {
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    const ownerActor = {
      actor: 'account',
      role: 'owner',
      member: owner.member_id,
      account: await accountOf(owner),
    };
    const widen = "update household set identity_audience = 'family'";
    // Wider before any notice: refused, the vault itself included.
    expect(await as(ownerActor, widen)).toBe('23514');
    expect(await as({ actor: 'system' }, widen)).toBe('23514');
    // Narrower is an owner's, or the vault's: an adult is refused.
    const owning = admin();
    try {
      await owning.query("update household set identity_audience = 'adults' where id = $1", [
        owner.household_id,
      ]);
      const narrow = "update household set identity_audience = 'owners_and_self'";
      expect(await as({ actor: 'account', role: 'adult', member: sara.member_id }, narrow)).toBe(
        '42501',
      );
      expect(await as(ownerActor, narrow)).toBe(1);
      expect(await as({ actor: 'system' }, narrow)).toBe(1);
    } finally {
      await owning.query(
        "update household set identity_audience = 'owners_and_self' where id = $1",
        [owner.household_id],
      );
      await owning.end();
    }
    // A notice: asked now and for 72 hours, by an owner in their own name.
    const ask = (until: string, at = 'now()') =>
      `insert into notice_request (household_id, kind, subject, requested_by, requested_at, notice_until)
       values (app_household(), 'identity_audience', 'family', app_account(), ${at}, ${until})`;
    expect(await as(ownerActor, ask("now() + interval '71 hours'"))).toBe('23514');
    expect(
      await as(ownerActor, ask("now() + interval '72 hours'", "now() - interval '5 days'")),
    ).toBe('23514');
    expect(
      await as(
        { actor: 'account', role: 'adult', member: sara.member_id, account: await accountOf(sara) },
        ask("now() + interval '72 hours'"),
      ),
    ).toBe('42501');
    expect(await as(ownerActor, ask("now() + interval '72 hours'"))).toBe(1);
    // Never removed.
    expect(await as(ownerActor, 'delete from notice_request')).toBe('42501');
    // A viewer writes no identity details, not even their own; a link reads none.
    expect(
      await as(
        { actor: 'account', role: 'viewer', member: viewer.member_id },
        'update member_identity set filled = filled',
      ),
    ).toBe(0);
    for (const actor of ['link', 'upload', 'anonymous', '']) {
      expect(
        await as(
          { actor, role: 'owner', member: owner.member_id },
          'select 1 from member_identity',
        ),
        actor,
      ).toBe(0);
      expect(await as({ actor, role: 'owner' }, 'select 1 from notice_request'), actor).toBe(0);
    }
    // Nor is a part removed, by anybody signed in.
    expect(await as(ownerActor, 'delete from member_identity')).toBe('42501');
    await pool.end();
  });

  it("As fdv_app with an owner's actor: the Only me row is invisible to a query with no WHERE clause", async () => {
    const pool = createPool(h.appUrl, 1);
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', 'owner', true),
                set_config('app.account_id', $3, true)`,
        [owner.household_id, owner.member_id, await accountOf(owner)],
      );
      const all = await c.query<{ member_id: string; part: string }>(
        'select member_id, part from member_identity',
      );
      expect(
        all.rows.filter((r) => r.part === 'only_me' && r.member_id !== owner.member_id),
      ).toEqual([]);
      expect(all.rows.some((r) => r.part === 'shared' && r.member_id === sara.member_id)).toBe(
        true,
      );
      // Nor changed, nor written as theirs.
      const touched = await c.query(
        "update member_identity set filled = '{}' where part = 'only_me'",
      );
      expect(touched.rowCount).toBe(0);
      await c.query('rollback');
      // As the vault itself: there.
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'system', true)`,
        [owner.household_id],
      );
      const vault = await c.query("select 1 from member_identity where part = 'only_me'");
      expect(vault.rowCount).toBeGreaterThan(0);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
      await pool.end();
    }
    // The Only me rule is the spec's, and holds on its own: with the rule
    // for each kind of caller taken away (in a transaction rolled back), an
    // owner still finds nobody else's Only me row.
    const owning = admin();
    const a = await owning.connect();
    try {
      const rule = await a.query<{ permissive: boolean; cmd: string; qual: string }>(
        `select polpermissive as permissive, polcmd as cmd, pg_get_expr(polqual, polrelid) as qual
           from pg_policy where polname = 'member_identity_only_me'`,
      );
      expect(rule.rows).toEqual([
        {
          permissive: false,
          cmd: '*',
          qual: "((part <> 'only_me'::text) OR (member_id = app_member()) OR (app_actor() = 'system'::text))",
        },
      ]);
      await a.query('begin');
      await a.query('drop policy member_identity_actor on member_identity');
      await a.query('drop policy member_identity_writer_update on member_identity');
      await a.query('set local role fdv_app_test');
      await a.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', 'owner', true)`,
        [owner.household_id, owner.member_id],
      );
      const alone = await a.query<{ member_id: string; part: string }>(
        'select member_id, part from member_identity',
      );
      expect(alone.rows.length).toBeGreaterThan(0);
      expect(alone.rows.filter((r) => r.part === 'only_me')).toEqual([]);
      expect(
        (await a.query("update member_identity set filled = '{}' where part = 'only_me'")).rowCount,
      ).toBe(0);
    } finally {
      await a.query('rollback').catch(() => undefined);
      a.release();
      await owning.end();
    }
  });

  it('a record sealed for one person cannot be opened as another: moved onto somebody else, it opens for nobody', async () => {
    const pool = admin();
    try {
      // Sara's sealed shared part, copied onto Adam's row as it is.
      await pool.query(
        `update member_identity t set sealed = s.sealed, dek_wrapped = s.dek_wrapped
           from member_identity s
          where s.member_id = $1 and s.part = 'shared' and t.member_id = $2 and t.part = 'shared'`,
        [sara.member_id, adam.member_id],
      );
      const res = await get(owner, adam.member_id);
      expect(res.statusCode).toBe(500);
      for (const v of VALUES) expect(res.body).not.toContain(v);
      expect(res.body).not.toContain('Sara');
    } finally {
      // Adam's own again, as he would write it.
      await pool.query("delete from member_identity where member_id = $1 and part = 'shared'", [
        adam.member_id,
      ]);
      await pool.end();
    }
  });

  it('no identity value ever appears in audit, alert or push jobs', async () => {
    const pool = admin();
    try {
      const { rows } = await pool.query<{ action: string; detail: unknown }>(
        "select action, detail, actor_label from audit_event where action like 'identity.%'",
      );
      expect(rows.length).toBeGreaterThan(5);
      const log = JSON.stringify(rows);
      for (const v of [...VALUES, 'sara.home@example.test', 'Engineer'])
        expect(log, v).not.toContain(v);
    } finally {
      await pool.end();
    }
    const jobs = JSON.stringify(h.jobs);
    for (const v of [...VALUES, 'sara.home@example.test']) expect(jobs, v).not.toContain(v);
    const mail = JSON.stringify(mailSent(h));
    for (const v of VALUES) expect(mail, v).not.toContain(v);
  });

  it('the activity log: a look once a sitting; lines for the owners, the person and whoever did it; an Only me change for the person alone', async () => {
    const pool = admin();
    const count = async (action: string, member: string) =>
      (
        await pool.query<{ n: number }>(
          'select count(*)::int as n from audit_event where action = $1 and object_id = $2',
          [action, member],
        )
      ).rows[0]?.n ?? 0;
    try {
      const looks = await count('identity.viewed', sara.member_id);
      await get(owner, sara.member_id);
      await get(owner, sara.member_id);
      await Promise.all([get(owner, sara.member_id), get(owner, sara.member_id)]);
      expect(await count('identity.viewed', sara.member_id)).toBe(looks === 0 ? 1 : looks);
      // A look at one's own is no line.
      const own = await count('identity.viewed', teen.member_id);
      await get(teen, teen.member_id);
      expect(await count('identity.viewed', teen.member_id)).toBe(own);
    } finally {
      await pool.end();
    }
    const v = json<IdentityView>(await get(sara, sara.member_id)).versions;
    expect(
      (
        await put(sara, sara.member_id, {
          part: 'only_me',
          version: v.only_me,
          fields: { notes: 'changed' },
        })
      ).statusCode,
    ).toBe(200);
    const saraSees = await activity(sara);
    expect(saraSees).toContain('Sara changed their own Only me identity details');
    expect(saraSees).toContain('Owner looked at Sara’s identity details');
    const ownerSees = await activity(owner);
    expect(ownerSees).not.toContain('Sara changed their own Only me identity details');
    expect(ownerSees).toContain('Owner changed Sara’s identity details');
    expect(ownerSees).toContain('Sara changed their own identity details');
    // Another adult and a teen see none of Sara's but their own looks.
    for (const who of [adam, teen]) {
      expect(
        (await activity(who)).filter(
          (l) => /Sara/.test(l) && /identity/.test(l) && !l.startsWith('Adam looked'),
        ),
      ).toEqual([]);
    }
  });

  it('a field the person takes out of their shared part ends everybody else’s exports, as a document made Only me does (5.27)', async () => {
    const pool = admin();
    try {
      const make = async (who: Tokens) =>
        (
          await pool.query<{ id: string }>(
            `insert into export (household_id, requested_by, state, expires_at)
             values ($1, $2, 'done', now() + interval '7 days') returning id`,
            [owner.household_id, await accountOf(who)],
          )
        ).rows[0]?.id as string;
      const live = async (id: string) =>
        (
          await pool.query<{ live: boolean }>(
            'select expires_at > now() as live from export where id = $1',
            [id],
          )
        ).rows[0]?.live;
      const shared = async (who: Tokens) => {
        const v = json<IdentityView>(await get(who, sara.member_id));
        return { version: v.versions.shared, fields: v.shared.fields };
      };
      const owners = await make(owner);
      const saras = await make(sara);
      // Something added: nothing ends.
      let now = await shared(sara);
      expect(
        (
          await put(sara, sara.member_id, {
            part: 'shared',
            version: now.version,
            fields: { ...now.fields, job_title: 'Surveyor' },
          })
        ).statusCode,
      ).toBe(200);
      expect(await live(owners)).toBe(true);
      // Taken out by an owner: the person's choice it is not, and nothing ends.
      now = await shared(owner);
      const withoutJob = { ...now.fields };
      delete withoutJob.job_title;
      expect(
        (
          await put(owner, sara.member_id, {
            part: 'shared',
            version: now.version,
            fields: withoutJob,
          })
        ).statusCode,
      ).toBe(200);
      expect(await live(owners)).toBe(true);
      // Taken out by the person themselves: every export but their own ends.
      now = await shared(sara);
      const kept = { ...now.fields };
      delete kept.family_name;
      expect(now.fields.family_name).toBeTruthy();
      expect(
        (await put(sara, sara.member_id, { part: 'shared', version: now.version, fields: kept }))
          .statusCode,
      ).toBe(200);
      expect(await live(owners)).toBe(false);
      expect(await live(saras)).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
