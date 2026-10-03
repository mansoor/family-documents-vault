import { randomUUID } from 'node:crypto';
import { EnvKeyProvider, ScopeKeys, sealIdentity } from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  can,
  canChangeDetails,
  canEditIdentity,
  canSee,
  canSeeCollection,
  canSeeIdentity,
  IDENTITY_AUDIENCES,
  IDENTITY_PARTS,
  identityAudienceSees,
  mayKeepOffline,
  ROLES,
  rolesWith,
  type CollectionDetail,
  type CollectionView,
  type DocumentView,
  type Role,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * One rule, several copies.
 *
 * Who may see a document is written once in words — everyone, the adults,
 * or only its owner — and several times in code: the SQL in the document
 * list, in search, in the reminder list, the share-link list, the tag list,
 * the issuer list and the documents in a collection (5.14), and `canSee` in
 * `@fdv/shared`,
 * which the worker uses to cut each person's digest. The digest leak fixed
 * in 0.4.2 was a copy that forgot the rule entirely, so this holds every
 * copy the API serves to the same answers as the shared one, for every
 * role, over documents of every visibility and more than one owner.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');

describe.skipIf(!testAdminUrl())('the visibility rule has one meaning everywhere', () => {
  let h: Harness;
  const people = {} as Record<Role, Tokens>;
  const docs: Array<{
    id: string;
    visibility: string;
    owner_member_id: string;
    tag: string;
    version_id: string;
  }> = [];

  let n = 0;
  const make = async (
    as: Tokens,
    title: string,
    visibility: 'household' | 'adults' | 'private',
  ) => {
    const tag = `parity${++n}`;
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(as),
      payload: {
        title: `Parity ${title}`,
        type_key: 'utility_bill',
        owner_member_id: as.member_id,
        visibility,
        tags: [tag],
        // One issuer per document, as telling as its title (0.4.10).
        issued_by: `Parity issuer ${tag}`,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const doc = created.json<DocumentView>();
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const uploaded = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/versions`,
      headers: { ...h.as(as), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    docs.push({
      id: doc.id,
      visibility,
      owner_member_id: as.member_id,
      tag,
      version_id: uploaded.json<{ id: string }>().id,
    });
    // A link out of the house to every one of them, which names it.
    const shared = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/share`,
      headers: h.as(as),
      payload: { recipient_label: 'the accountant' },
    });
    expect(shared.statusCode, shared.body).toBe(201);
    // A reminder on every one of them, set by whoever made it.
    const reminder = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reminders',
      headers: h.as(as),
      payload: { document_id: doc.id, fire_at: '2030-01-01' },
    });
    expect(reminder.statusCode, reminder.body).toBe(201);
  };

  beforeAll(async () => {
    h = await createHarness();
    people.owner = await h.setup();
    people.adult = await h.join(people.owner, {
      name: 'Adult',
      email: 'parity-adult@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Teen',
      email: 'parity-teen@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Viewer',
      email: 'parity-viewer@example.test',
      role: 'viewer',
    });
    await make(people.owner, 'household', 'household');
    await make(people.owner, 'adults', 'adults');
    await make(people.owner, 'owner private', 'private');
    await make(people.adult, 'adults by the adult', 'adults');
    await make(people.adult, 'adult private', 'private');
  }, 90_000);
  afterAll(() => h.close());

  const expected = (role: Role) =>
    docs
      .filter((d) => canSee({ role, memberId: people[role].member_id }, d))
      .map((d) => d.id)
      .sort();

  const roles: Role[] = ['owner', 'adult', 'teen', 'viewer'];

  it.each(roles)('the document list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/documents?limit=200',
      headers: h.as(people[role]),
    });
    const ids = res
      .json<{ items: DocumentView[] }>()
      .items.map((d) => d.id)
      .filter((id) => docs.some((d) => d.id === id))
      .sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the reminder list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/reminders?state=all',
      headers: h.as(people[role]),
    });
    const ids = [
      ...new Set(
        res
          .json<{ items: Array<{ document_id: string }> }>()
          .items.map((r) => r.document_id)
          .filter((id) => docs.some((d) => d.id === id)),
      ),
    ].sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('search agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/search?q=parity',
      headers: h.as(people[role]),
    });
    expect(res.statusCode, res.body).toBe(200);
    const ids = res
      .json<{ items: Array<{ document_id: string }> }>()
      .items.map((r) => r.document_id)
      .filter((id) => docs.some((d) => d.id === id))
      .sort();
    expect(ids).toEqual(expected(role));
  });

  // Only those who may share see the links at all (0.5.0); for them, the
  // list names only what they may see.
  it.each(roles)('the share-link list agrees with canSee for a %s who may share', async (role) => {
    const res = await h.app.inject({ url: '/api/v1/shares', headers: h.as(people[role]) });
    expect(res.statusCode, res.body).toBe(200);
    const ids = [
      ...new Set(
        res
          .json<{ items: Array<{ document_id: string }> }>()
          .items.map((s) => s.document_id)
          .filter((id) => docs.some((d) => d.id === id)),
      ),
    ].sort();
    expect(ids).toEqual(can(role, 'document.share') ? expected(role) : []);
  });

  it.each(roles)('the tag list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({ url: '/api/v1/tags?q=parity', headers: h.as(people[role]) });
    expect(res.statusCode, res.body).toBe(200);
    const tags = res.json<{ items: Array<{ tag: string }> }>().items.map((t) => t.tag);
    const ids = docs
      .filter((d) => tags.includes(d.tag))
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the issuer list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/issuers?q=Parity%20issuer',
      headers: h.as(people[role]),
    });
    expect(res.statusCode, res.body).toBe(200);
    const issuers = res
      .json<{ items: Array<{ issued_by: string }> }>()
      .items.map((i) => i.issued_by);
    const ids = docs
      .filter((d) => issuers.includes(`Parity issuer ${d.tag}`))
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the pages endpoint agrees with canSee for a %s', async (role) => {
    const seen: string[] = [];
    for (const d of docs) {
      const res = await h.app.inject({
        url: `/api/v1/versions/${d.version_id}/pages/1`,
        headers: h.as(people[role]),
      });
      // Seen: on its way, or asking who is there. Not seen: not there at all.
      const code = res.json<{ error: { code: string } }>().error.code;
      if (code !== 'not_found') seen.push(d.id);
    }
    expect(seen.sort()).toEqual(expected(role));
  });

  describe('collections (5.14)', () => {
    /** An everyone collection by each adult, with every parity document they can see in it. */
    const collections: string[] = [];
    beforeAll(async () => {
      for (const who of ['owner', 'adult'] as const) {
        const made = await h.app.inject({
          method: 'POST',
          url: '/api/v1/collections',
          headers: h.as(people[who]),
          payload: { name: `Parity ${who}`, audience: 'everyone' },
        });
        expect(made.statusCode, made.body).toBe(201);
        const id = made.json<CollectionDetail>().id;
        const added = await h.app.inject({
          method: 'POST',
          url: `/api/v1/collections/${id}/items`,
          headers: h.as(people[who]),
          payload: { document_ids: expected(who) },
        });
        expect(added.statusCode, added.body).toBe(200);
        collections.push(id);
      }
    });

    /** Of every parity document, what a role is shown in a collection: none to a viewer (A17). */
    const inCollections = (role: Role) =>
      canSeeCollection(
        { role, memberId: people[role].member_id },
        { audience: 'everyone', owner_member_id: null },
      )
        ? expected(role)
        : [];

    it.each(roles)('the documents in a collection agree with canSee for a %s', async (role) => {
      const res = await h.app.inject({ url: '/api/v1/collections', headers: h.as(people[role]) });
      expect(res.statusCode, res.body).toBe(200);
      const ids = new Set<string>();
      for (const l of res
        .json<{ items: CollectionView[] }>()
        .items.filter((x) => collections.includes(x.id))) {
        const one = await h.app.inject({
          url: `/api/v1/collections/${l.id}`,
          headers: h.as(people[role]),
        });
        const detail = one.json<CollectionDetail>();
        // The count is what the reader is given, wherever it is read.
        expect(detail.item_count).toBe(detail.items.length);
        expect(l.item_count).toBe(detail.items.length);
        for (const i of detail.items) ids.add(i.document.id);
      }
      expect([...ids].sort()).toEqual(inCollections(role));
    });

    it.each(roles)("a document's collections agree with canSee for a %s", async (role) => {
      const on: string[] = [];
      for (const d of docs) {
        const res = await h.app.inject({
          url: `/api/v1/documents/${d.id}/collections`,
          headers: h.as(people[role]),
        });
        if (res.statusCode !== 200) continue;
        const items = res.json<{ items: CollectionView[] }>().items;
        if (items.some((l) => collections.includes(l.id))) on.push(d.id);
      }
      expect(on.sort()).toEqual(inCollections(role));
    });
  });

  describe('the offline set (0.4.13)', () => {
    beforeAll(async () => {
      // Every parity document made Essential, by whoever made it.
      for (const d of docs) {
        const who = Object.values(people).find((t) => t.member_id === d.owner_member_id) as Tokens;
        const res = await h.app.inject({
          method: 'PATCH',
          url: `/api/v1/documents/${d.id}`,
          headers: h.as(who),
          payload: { is_essential: true },
        });
        expect(res.statusCode, res.body).toBe(200);
      }
    });

    /** Each person's phone, with a grant where the vault gives one (never to a viewer). */
    const emails: Record<Role, string> = {
      owner: 'owner@example.test',
      adult: 'parity-adult@example.test',
      teen: 'parity-teen@example.test',
      viewer: 'parity-viewer@example.test',
    };
    const phoneOf = async (role: Role) => {
      const password = role === 'owner' ? 'correct horse battery' : 'another correct horse';
      const signedIn = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        remoteAddress: `10.55.0.${roles.indexOf(role) + 1}`,
        headers: { 'x-fdv-installation': randomUUID() },
        payload: { email: emails[role], password },
      });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      const t = signedIn.json<Tokens>();
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/offline/grant',
        remoteAddress: `10.55.1.${roles.indexOf(role) + 1}`,
        headers: h.as(t),
        payload: { password },
      });
      return t;
    };

    it.each(roles)('agrees with canSee and the role policy for a %s', async (role) => {
      const res = await h.app.inject({
        url: '/api/v1/offline/essentials',
        headers: h.as(await phoneOf(role)),
      });
      expect(res.statusCode, res.body).toBe(200);
      const ids = res
        .json<{ items: Array<{ document: { id: string } }> }>()
        .items.map((i) => i.document.id)
        .filter((id) => docs.some((d) => d.id === id))
        .sort();
      const expectedIds = docs
        .filter((d) =>
          mayKeepOffline(
            { role, memberId: people[role].member_id },
            { ...d, is_essential: true },
            false,
          ),
        )
        .map((d) => d.id)
        .sort();
      expect(ids).toEqual(expectedIds);
    });
  });

  it('the rule is not vacuous: every role is refused something here', () => {
    for (const role of roles) expect(expected(role).length, role).toBeLessThan(docs.length);
    // And the two adults each see exactly one private document: their own.
    expect(expected('owner')).not.toEqual(expected('adult'));
  });

  it("member_photo's policy admits exactly the roles of family.details", async () => {
    // A photo of somebody with no sign-in, which nobody asking below is.
    const hh = people.owner.household_id;
    await withSystem(h.db, hh, async (trx) => {
      const child = await trx
        .insertInto('member')
        .values({ household_id: hh, display_name: 'Photographed' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('member_photo')
        .values({
          household_id: hh,
          member_id: child.id,
          state: 'ready',
          sealed: Buffer.alloc(40),
          ready_at: new Date(),
        })
        .execute();
    });
    // The database's rule (0040), asked as each role would be, past the
    // application: somebody signed in who is not the person in it.
    const pool = createPool(h.appUrl, 1);
    const seen = async (role: string) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', $3, true)`,
          [hh, people.viewer.member_id, role],
        );
        const { rows } = await c.query<{ n: number }>(
          "select count(*)::int as n from member_photo m join member p on p.id = m.member_id where p.display_name = 'Photographed'",
        );
        await c.query('commit');
        return (rows[0]?.n ?? 0) > 0;
      } finally {
        c.release();
      }
    };
    try {
      for (const role of ROLES) {
        expect(await seen(role), role).toBe(can(role, 'family.details'));
      }
      // A role never heard of, however it is written, is nobody's.
      for (const role of ['', 'guest', 'OWNER', ' owner']) {
        expect(await seen(role), JSON.stringify(role)).toBe(false);
      }
    } finally {
      await pool.end();
    }
    expect(rolesWith('family.details')).toEqual(['owner', 'adult', 'teen']);
  });

  it("member's rule for changing a person admits exactly canChangeDetails; an owner alone records a passing; the version is the database's (0046)", async () => {
    const hh = people.owner.household_id;
    // Somebody with no sign-in, whom nobody asking below is.
    const unsigned = (
      await withSystem(h.db, hh, (trx) =>
        trx
          .insertInto('member')
          .values({ household_id: hh, display_name: 'Unsigned' })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id;
    // The database's rules, asked as each caller would be, past the
    // application: one statement, rolled back, and what it changed.
    const pool = createPool(h.appUrl, 1);
    const ask = async (
      who: { actor: string; role?: string; member?: string },
      id: string,
      set: string,
    ): Promise<number | string> => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true),
                  set_config('app.member_id', $3, true), set_config('app.role', $4, true)`,
          [hh, who.actor, who.member ?? '', who.role ?? ''],
        );
        const r = await c.query(`update member set ${set} where id = $1`, [id]);
        return r.rowCount ?? 0;
      } catch (err) {
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    try {
      for (const role of ROLES) {
        const me = people[role].member_id;
        const other = role === 'adult' ? people.teen : people.adult;
        for (const [id, targetRole] of [
          [me, role],
          [other.member_id, other.role],
          [unsigned, null],
        ] as const) {
          const may = canChangeDetails({ role, memberId: me }, { id, role: targetRole });
          expect(
            await ask({ actor: 'account', role, member: me }, id, "relationship = 'x'"),
            `${role} → ${targetRole ?? 'no sign-in'}`,
          ).toBe(may ? 1 : 0);
        }
      }
      // A role never heard of, however it is written, changes nobody; nor
      // does any caller but somebody signed in and the vault itself.
      for (const role of ['', 'guest', 'OWNER', ' owner']) {
        expect(await ask({ actor: 'account', role }, unsigned, "relationship = 'x'"), role).toBe(0);
      }
      for (const actor of ['', 'anonymous', 'upload', 'link']) {
        expect(await ask({ actor, role: 'owner' }, unsigned, "relationship = 'x'"), actor).toBe(0);
      }
      expect(await ask({ actor: 'system' }, unsigned, "relationship = 'x'")).toBe(1);

      // That somebody has passed away: an owner's, or the vault's; anybody
      // else signed in is refused outright, though they may change the rest.
      const passing = 'is_deceased = true';
      expect(await ask({ actor: 'account', role: 'owner', member: 'x' }, unsigned, passing)).toBe(
        1,
      );
      expect(await ask({ actor: 'system' }, unsigned, passing)).toBe(1);
      expect(
        await ask(
          { actor: 'account', role: 'adult', member: people.adult.member_id },
          unsigned,
          passing,
        ),
      ).toBe('42501');
      expect(
        await ask(
          { actor: 'account', role: 'teen', member: people.teen.member_id },
          people.teen.member_id,
          passing,
        ),
      ).toBe('42501');
    } finally {
      await pool.end();
    }

    // The version moves by one with a detail, and with nothing else; nobody
    // sets it, or when, or by whom.
    const version = () =>
      withSystem(h.db, hh, (trx) =>
        trx
          .selectFrom('member')
          .select(['version', 'updated_at', 'updated_by'])
          .where('id', '=', unsigned)
          .executeTakeFirstOrThrow(),
      );
    const change = (set: Record<string, unknown>) =>
      withSystem(h.db, hh, (trx) =>
        trx.updateTable('member').set(set).where('id', '=', unsigned).execute(),
      );
    expect(await version()).toMatchObject({ version: 1, updated_at: null, updated_by: null });
    await change({ relationship: 'Cousin' });
    const once = await version();
    expect(once.version).toBe(2);
    expect(once.updated_at).toBeInstanceOf(Date);
    // The vault itself is nobody's account.
    expect(once.updated_by).toBeNull();
    await change({ colour: 5, former_account_id: null });
    expect(await version()).toEqual(once);
    await change({ version: 99, updated_at: new Date(0), updated_by: null });
    expect(await version()).toEqual(once);
    await change({ version: 99, display_name: 'Unsigned Cousin' });
    expect((await version()).version).toBe(3);
  });

  it("member_identity's rules admit exactly canSeeIdentity and canEditIdentity, for every role and audience (0050)", async () => {
    const hh = people.owner.household_id;
    // The two copies of the audience, asked of every audience and of roles
    // and audiences never heard of.
    const pool = createPool(h.appUrl, 1);
    const admin = createPool(h.adminUrl, 1);
    try {
      for (const aud of [...IDENTITY_AUDIENCES, 'everyone', '', 'ADULTS']) {
        for (const role of [...ROLES, 'guest', '', 'OWNER']) {
          const { rows } = await pool.query<{ sees: boolean }>(
            'select identity_audience_sees($1, $2) as sees',
            [aud, role],
          );
          expect(rows[0]?.sees, `${aud} / ${role}`).toBe(identityAudienceSees(aud, role as Role));
        }
      }
      // A shared and an Only me part for each of them, sealed as the API seals.
      const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
      await withSystem(h.db, hh, async (trx) => {
        const identity = await keys.identityKey(trx, hh);
        for (const role of ROLES) {
          const memberId = people[role].member_id;
          const own = await keys.unwrap(trx, { householdId: hh, kind: 'member', memberId });
          for (const [part, key] of [
            ['shared', identity],
            ['only_me', own],
          ] as const) {
            const sealed = sealIdentity(key.key, { householdId: hh, memberId, part }, {});
            await trx
              .insertInto('member_identity')
              .values({
                household_id: hh,
                member_id: memberId,
                part,
                ...sealed,
                wrapped_by_scope: key.id,
              })
              .onConflict((oc) => oc.columns(['member_id', 'part']).doNothing())
              .execute();
          }
        }
      });
      const ask = async (role: Role, text: string): Promise<Set<string>> => {
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                    set_config('app.member_id', $2, true), set_config('app.role', $3, true)`,
            [hh, people[role].member_id, role],
          );
          const r = await c.query<{ member_id: string; part: string }>(text);
          return new Set(r.rows.map((x) => `${x.member_id}:${x.part}`));
        } finally {
          await c.query('rollback').catch(() => undefined);
          c.release();
        }
      };
      for (const aud of IDENTITY_AUDIENCES) {
        await admin.query('update household set identity_audience = $1 where id = $2', [aud, hh]);
        for (const role of ROLES) {
          const me = { role, memberId: people[role].member_id };
          const seen = await ask(role, 'select member_id, part from member_identity');
          const written = await ask(
            role,
            'update member_identity set filled = filled returning member_id, part',
          );
          for (const subject of ROLES) {
            for (const part of IDENTITY_PARTS) {
              const row = `${people[subject].member_id}:${part}`;
              const id = { id: people[subject].member_id };
              expect(seen.has(row), `${aud}: ${role} reads ${subject}'s ${part}`).toBe(
                canSeeIdentity(me, id, aud, part),
              );
              expect(written.has(row), `${aud}: ${role} writes ${subject}'s ${part}`).toBe(
                canEditIdentity(me, id, part),
              );
            }
          }
        }
      }
    } finally {
      await admin.query(
        "update household set identity_audience = 'owners_and_self' where id = $1",
        [hh],
      );
      await admin.end();
      await pool.end();
    }
  });
});
