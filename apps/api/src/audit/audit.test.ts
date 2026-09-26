import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendAudit, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { describeEvent, type ActivityLine, type DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { hasRule, shownTo, type Reader } from './service.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');

/**
 * The household activity log (SHR-07) and the private moment (SEC-19).
 *
 * The log's whole job is trust between adults, so the tests are mostly
 * about what does *not* appear in somebody else's copy of it.
 */
describe.skipIf(!testAdminUrl())('the activity log', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let teen: Tokens;
  let mine: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const activity = async (as: Tokens) =>
    json<{ items: ActivityLine[]; next: number | null }>(
      await h.app.inject({ url: '/api/v1/audit', headers: h.as(as) }),
    );

  const texts = async (as: Tokens) => (await activity(as)).items.map((l) => l.text);

  const make = async (title: string, as: Tokens = owner) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(as),
      payload: { title, type_key: 'utility_bill', owner_member_id: owner.member_id },
    });
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(as), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    return id;
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Aisha', email: 'aisha@example.test', role: 'teen' });
    mine = await make('Home insurance policy');
  }, 90_000);
  afterAll(() => h.close());

  it('reads like sentences, not like a table', async () => {
    const lines = await texts(owner);
    expect(lines).toContain('Owner added “Home insurance policy”');
    expect(lines).toContain('Owner uploaded a new copy of “Home insurance policy”');
    expect(lines).toContain('Owner set up the vault');
    // No uuids, no action names, no field names anywhere in the list.
    for (const line of lines) {
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(line).not.toMatch(/document\.|member\.|_id|null|undefined/);
    }
  });

  it('a download by another adult shows up, named', async () => {
    const version = json<{ items: Array<{ id: string }> }>(
      await h.app.inject({ url: `/api/v1/documents/${mine}/versions`, headers: h.as(owner) }),
    ).items[0] as { id: string };
    await h.app.inject({ url: `/api/v1/versions/${version.id}/content`, headers: h.as(sam) });

    expect(await texts(owner)).toContain('Sam downloaded “Home insurance policy”');
  });

  it('a private document is in nobody else’s copy of the list', async () => {
    const secret = await make('Therapy notes');
    const marked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secret}/visibility`,
      headers: h.as(owner),
      payload: { visibility: 'private' },
    });
    expect(marked.statusCode).toBe(200);

    // The owner sees the whole story of their own document.
    const theirs = await texts(owner);
    expect(theirs).toContain('Owner added “Therapy notes”');
    expect(
      theirs.some((t) => t.includes('“Therapy notes”') && t.includes('only they can see')),
    ).toBe(true);

    // Sam sees none of it — not the title, and not a redacted line where
    // it used to be. "Somebody did something to a document" between two
    // adults in a shared vault is worse than silence.
    const sams = await texts(sam);
    expect(sams.join(' ')).not.toContain('Therapy notes');
    expect(sams.join(' ')).not.toMatch(/a document/);
  });

  it('the same is true of adults-only documents for a teen', async () => {
    const forAdults = await make('Solicitor’s letter');
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${forAdults}/visibility`,
      headers: h.as(owner),
      payload: { visibility: 'adults' },
    });
    expect((await texts(teen)).join(' ')).not.toContain('Solicitor');
    expect((await texts(sam)).join(' ')).toContain('Solicitor');
  });

  it('a viewer — an outsider — cannot read the log at all', async () => {
    const viewer = await h.join(owner, {
      name: 'Accountant',
      email: 'acc@example.test',
      role: 'viewer',
    });
    const res = await h.app.inject({ url: '/api/v1/audit', headers: h.as(viewer) });
    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('forbidden');
  });

  it('a shared link opening shows as the link, not as a person', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${mine}/share`,
      headers: h.as(owner),
      payload: { recipient_label: 'the letting agent' },
    });
    const token = json<{ link_token: string }>(created).link_token;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/shared/${token}/open`,
      payload: {},
      remoteAddress: '10.4.4.4',
    });

    const lines = await texts(owner);
    expect(lines).toContain('Shared link (the letting agent) opened “Home insurance policy”');
    expect(lines).toContain('Owner made a link to “Home insurance policy” for the letting agent');
  });

  it('a line about an unknown object type is shown to nobody', async () => {
    // The same action with a sentence, once about a member and once about
    // a kind of thing nobody has said the audience of.
    await withSystem(h.db, owner.household_id, async (trx) => {
      for (const [objectType, name] of [
        ['member', 'Crumpet'],
        ['pet', 'Biscuit'],
      ] as const) {
        await appendAudit(trx, {
          householdId: owner.household_id,
          action: 'member.added',
          objectType,
          objectId: randomUUID(),
          detail: { display_name: name },
        });
      }
    });
    for (const reader of [owner, sam, teen]) {
      const lines = (await texts(reader)).join(' ');
      expect(lines).toContain('Somebody added Crumpet to the family');
      expect(lines).not.toContain('Biscuit');
    }
  });

  it('pages backwards without losing anything', async () => {
    const first = json<{ items: ActivityLine[]; next: number | null }>(
      await h.app.inject({ url: '/api/v1/audit?limit=3', headers: h.as(owner) }),
    );
    expect(first.items.length).toBeLessThanOrEqual(3);
    expect(first.next).not.toBeNull();

    const second = json<{ items: ActivityLine[] }>(
      await h.app.inject({
        url: `/api/v1/audit?limit=3&before=${first.next as number}`,
        headers: h.as(owner),
      }),
    );
    const ids = new Set(first.items.map((l) => l.id));
    for (const l of second.items) expect(ids.has(l.id)).toBe(false);
  });
});

/**
 * The log denies by default (5.6): a line is shown only when a rule says to
 * whom, and nothing new inherits an audience by being about a familiar kind
 * of thing.
 */
describe('who reads each line', () => {
  const readers: Array<[string, Reader]> = [
    ['an owner', { role: 'owner', memberId: randomUUID() }],
    ['an adult', { role: 'adult', memberId: randomUUID() }],
    ['a teen', { role: 'teen', memberId: randomUUID() }],
  ];
  const about = (action: string, object_type: string | null) => ({
    action,
    object_type,
    document_visibility: null,
    document_owner: null,
  });

  /** Every action `@fdv/shared/activity` has a sentence for, read from its source. */
  const said = async () => {
    const source = await readFile(
      new URL('../../../../packages/shared/src/activity.ts', import.meta.url),
      'utf8',
    );
    return [...source.matchAll(/case '([a-z_]+\.[a-z_]+)':/g)].map((m) => m[1] as string);
  };
  const withoutRule = (actions: string[]) => actions.filter((a) => !hasRule(a));

  it('an action with a sentence but no rule fails the test', async () => {
    const actions = await said();
    // Read right: each of these really is said.
    expect(actions.length).toBeGreaterThan(30);
    for (const action of actions) {
      const line = describeEvent({
        id: 1,
        at: new Date().toISOString(),
        action,
        actor: 'Sam',
        actor_label: null,
        object_type: null,
        object_id: null,
        object_title: null,
        detail: {},
      });
      expect(line, action).not.toBeNull();
    }
    expect(withoutRule(actions)).toEqual([]);
    // And a sentence added tomorrow without a rule is caught here.
    expect(withoutRule([...actions, 'member.made_owner'])).toEqual(['member.made_owner']);
  });

  it('a new action on `member` with no row of its own is shown to nobody, not to everyone who sees `member` lines', () => {
    for (const [who, reader] of readers) {
      // Today's lines about a member are everyone's …
      expect(shownTo(reader, about('member.role_changed', 'member')), who).toBe(true);
      expect(shownTo(reader, about('member.sign_in_removed', 'member')), who).toBe(true);
      // … and an owner's action from 5.28–5.30, before its iteration gives
      // it an audience, is nobody's.
      expect(shownTo(reader, about('member.made_owner', 'member')), who).toBe(false);
      expect(shownTo(reader, about('member.suspended', 'member')), who).toBe(false);
      // Nor does a name that happens to be on every object count as a rule.
      expect(shownTo(reader, about('constructor', 'member')), who).toBe(false);
    }
  });

  it("a document's line follows the document, and with no row to go by is nobody's", () => {
    const [owner, adult, teen] = readers.map(([, r]) => r) as [Reader, Reader, Reader];
    const doc = (visibility: 'household' | 'adults' | 'private' | null, by: string | null) => ({
      action: 'document.downloaded',
      object_type: 'document',
      document_visibility: visibility,
      document_owner: by,
    });
    expect([owner, adult, teen].map((r) => shownTo(r, doc('household', null)))).toEqual([
      true,
      true,
      true,
    ]);
    expect([owner, adult, teen].map((r) => shownTo(r, doc('adults', null)))).toEqual([
      true,
      true,
      false,
    ]);
    expect([owner, adult, teen].map((r) => shownTo(r, doc('private', adult.memberId)))).toEqual([
      false,
      true,
      false,
    ]);
    expect([owner, adult, teen].map((r) => shownTo(r, doc(null, null)))).toEqual([
      false,
      false,
      false,
    ]);
  });
});

/**
 * SEC-19: the one sentence that has to be said when a document becomes
 * something only one person can open.
 */
describe.skipIf(!testAdminUrl())('the private moment', () => {
  let h: Harness;
  let owner: Tokens;
  let doc: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const setVisibility = (to: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc}/visibility`,
      headers: h.as(owner),
      payload: { visibility: to },
    });

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'My will', type_key: 'will', owner_member_id: owner.member_id },
    });
    doc = created.json<DocumentView>().id;
  }, 60_000);
  afterAll(() => h.close());

  it('says it at the moment it becomes true, and says what it means', async () => {
    const res = await setVisibility('private');
    expect(res.statusCode).toBe(200);
    const { notice } = json<{ notice: { title: string; body: string } }>(res);
    expect(notice.title).toBe('Only you can open this');
    expect(notice.body).toMatch(/Nobody can open it after you, unless you leave a key/);
    // Brief, plain and unsentimental: it is a message about death.
    expect(notice.body.length).toBeLessThan(220);
    expect(notice.body).not.toMatch(/sorry|unfortunately|please note/i);
  });

  it('never says it twice for the same document', async () => {
    await setVisibility('household');
    const again = await setVisibility('private');
    expect(json<{ notice: null }>(again).notice).toBeNull();
  });

  it('says nothing at all when a document is not being made private', async () => {
    expect(json<{ notice: null }>(await setVisibility('household')).notice).toBeNull();
    expect(json<{ notice: null }>(await setVisibility('adults')).notice).toBeNull();
  });
});
