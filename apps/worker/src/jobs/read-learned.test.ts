import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  EncryptStream,
  EnvKeyProvider,
  itemProposalsBinding,
  newKey,
  openBytes,
  ScopeKeys,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import {
  learningOf,
  LEARNED_CONFIDENCE,
  LEARNED_SURE_CONFIDENCE,
  levelItem,
  storedLearnedClash,
  storedProposal,
  teach,
  type BatchLevel,
  type DetailProposal,
  type KeptRule,
  type LearnedClash,
  type LevelKind,
  type TypeField,
} from '@fdv/shared';
import { FIXTURE_ISSUERS, HELD_OUT, TUNED, type ProposalFixture } from '@fdv/shared/testdata';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { extractText } from './extract-text.js';
import type { IncomingDeps } from './incoming.js';
import { ProposalThread } from './proposal-thread.js';
import { learnedContext, readNextBatchItem } from './read-item.js';
import { detectTools } from './tools.js';

/**
 * The vault learns from your corrections (Phase 6, I4), in the worker: an
 * item is read with its uploader's own rules — read as them, so the
 * database gives nobody else's — on the proposal thread, beside the pages'
 * words. What the rules propose says so (cue `learned`); a sure rule that
 * disagrees with the pages is sealed beside the proposal, never put in its
 * place. And 5.37's fixtures read twice: before learning, and after their
 * corrections taught the rules.
 */

const MASTER = 'read-learned-test-master-key-with-32-bytes-or-more';
const tools = await detectTools();

/** Stands in for the words' extraction: these words, read from the pages' own text. */
const says =
  (text: string): typeof extractText =>
  async () => ({ text, source: 'pdf', textPages: 1, ocrPages: 0 });

/** A letter from the dentist, naming nobody: what the pages alone cannot place. */
const DENTIST = [
  'Northgate Dental',
  '14 Mill Lane, Leeds LS1 4AB',
  'Dear patient,',
  'Thank you for your visit on 2 March 2026. Your next check-up is due in six months.',
  'Yours sincerely',
].join('\n');

describe.skipIf(!testAdminUrl())('an item read with its uploader’s own rules (I4)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  let deps: IncomingDeps;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  let vault: string;
  const m: Record<string, string> = {};
  const acct: Record<string, string> = {};
  let thread: ProposalThread;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-learned-'));
    hh = randomUUID();
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'The Khan family', 'Europe/London')",
      [hh],
    );
    await admin.query("insert into household_profile (household_id, country) values ($1, 'GB')", [
      hh,
    ]);
    for (const [name, role] of [
      ['Olivia', 'owner'],
      ['Sara', 'adult'],
      ['Ahmed', 'adult'],
      ['Zain', 'teen'],
      ['Granny Ruth', null],
    ] as const) {
      m[name] = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, name],
        )
      ).rows[0]?.id as string;
      if (!role) continue;
      acct[name] = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          `${name.toLowerCase().replace(' ', '-')}-${stamp}@learned.test`,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [acct[name], hh, m[name], role],
      );
    }
    vault = await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const who of ['Olivia', 'Sara', 'Ahmed', 'Zain', 'Granny Ruth']) {
        await keys.mintMemberKey(trx, hh, m[who] as string, null);
      }
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
      return v.id;
    });
    // The dentist, on a letter everybody sees: one of the household's issuers.
    await admin.query(
      "insert into document (household_id, title, issued_by, visibility) values ($1, 'Dentist', 'Northgate Dental', 'household')",
      [hh],
    );
    deps = {
      admin,
      db,
      keys,
      credentialsKey: Buffer.alloc(32),
      localRoot: root,
      log: () => undefined,
    };
    thread = new ProposalThread();
  }, 60_000);

  afterAll(async () => {
    await thread?.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await rm(root, { recursive: true, force: true });
  });

  const batch = async (who: string) =>
    (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, ends_at)
         values ($1, $2, $3, now() + interval '30 days') returning id`,
        [hh, acct[who], m[who]],
      )
    ).rows[0]?.id as string;

  /** An item of `who`'s, its bytes encrypted under its own key, its pages drawn. */
  const item = async (who: string) => {
    const batchId = await batch(who);
    const id = randomUUID();
    const key = `${hh}/batches/${batchId}/${randomBytes(8).toString('hex')}.enc`;
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: m[who] as string }),
    );
    const fileKey = newKey();
    const bytes = Buffer.from(`%PDF-1.4\n% ${id}\n%%EOF\n`);
    const enc = new EncryptStream(fileKey);
    await Promise.all([
      new LocalAdapter(root).put(key, enc),
      pipeline(Readable.from([bytes]), enc),
    ]);
    await admin.query(
      `insert into incoming_file (id, household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  scan_state, read_state, preview_state, preview_pages,
                                  received_at, submitted_at)
       values ($1, $2, $3, 'me', $4, 'received', 'scan.pdf', 'application/pdf', $5, $6, 38, $7, $8,
               $9, $10, $11, 'member', 'unscanned', 'waiting', 'ready', 1, now(), now())`,
      [
        id,
        hh,
        batchId,
        m[who],
        bytes.length,
        randomBytes(32),
        randomBytes(32),
        key,
        vault,
        wrapKey(fileKey, scope.key, `incoming:${id}`),
        scope.id,
      ],
    );
    return { id, fileKey };
  };

  /** What was sealed for an item: its proposal, and where a sure rule disagreed. */
  const sealed = async (i: { id: string; fileKey: Buffer }) => {
    const row = await admin.query<{ proposals_sealed: Buffer }>(
      'select proposals_sealed from incoming_file where id = $1',
      [i.id],
    );
    const raw: unknown = JSON.parse(
      openBytes(
        i.fileKey,
        row.rows[0]?.proposals_sealed as Buffer,
        itemProposalsBinding(i.id),
      ).toString('utf8'),
    );
    return { proposal: storedProposal(raw), clash: storedLearnedClash(raw) };
  };

  /** `who`'s item with these words, read now, as the worker reads it. */
  const readFor = async (who: string, text: string) => {
    await admin.query(
      "update incoming_file set read_state = 'failed', read_failure = 'unreadable' where household_id = $1 and state = 'received' and read_state in ('waiting', 'reading')",
      [hh],
    );
    const i = await item(who);
    const r = await readNextBatchItem(deps, hh, {
      maxPages: 5,
      proposer: thread,
      tools,
      extract: says(text),
    });
    expect(r.read).toBe(i.id);
    return sealed(i);
  };

  /** A rule of `who`'s, planted as the API keeps one. */
  const rule = (
    who: string,
    issuer: string,
    says: { kind?: string | undefined; person?: string | undefined },
    confirmed = 3,
    contradicted = 0,
  ) =>
    admin.query(
      `insert into intake_rule (household_id, member_id, issuer_key, type_key, person_id, confirmed, contradicted)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [hh, m[who], issuer, says.kind ?? null, says.person ?? null, confirmed, contradicted],
    );
  const forget = () => admin.query('delete from intake_rule where household_id = $1', [hh]);

  it('the pages name an issuer with a rule: the kind and the person proposed, learned — and only the uploader’s own', async () => {
    await forget();
    // Before any rule: the dentist is named, and nothing else is said.
    const before = await readFor('Ahmed', DENTIST);
    expect(before.proposal.issued_by).toMatchObject({ value: 'Northgate Dental' });
    expect(before.proposal.type_key).toBeUndefined();
    expect(before.proposal.owner_member_id).toBeUndefined();

    // Each adult's own rules for the same dentist; and the owner's.
    await rule('Ahmed', 'northgate dental', { kind: 'medical_record' });
    await rule('Ahmed', 'northgate dental', { person: m.Zain });
    await rule('Sara', 'northgate dental', { kind: 'utility_bill' }, 9);
    await rule('Sara', 'northgate dental', { person: m.Sara }, 9);
    await rule('Olivia', 'northgate dental', { kind: 'warranty' }, 7);

    const ahmed = await readFor('Ahmed', DENTIST);
    expect(ahmed.proposal).toMatchObject({
      type_key: { value: 'medical_record', cue: 'learned', confidence: LEARNED_SURE_CONFIDENCE },
      owner_member_id: { value: m.Zain, cue: 'learned', confidence: LEARNED_SURE_CONFIDENCE },
    });
    // Sara's are hers, and the owner's the owner's: neither reaches the other.
    const sara = await readFor('Sara', DENTIST);
    expect(sara.proposal).toMatchObject({
      type_key: { value: 'utility_bill', cue: 'learned' },
      owner_member_id: { value: m.Sara, cue: 'learned' },
    });
    const olivia = await readFor('Olivia', DENTIST);
    expect(olivia.proposal.type_key).toMatchObject({ value: 'warranty', cue: 'learned' });
    expect(olivia.proposal.owner_member_id).toBeUndefined();
  }, 60_000);

  it('the worker reads the rules as the uploader: the database gives it theirs alone', async () => {
    await forget();
    await rule('Ahmed', 'northgate dental', { kind: 'medical_record' });
    await rule('Sara', 'northgate dental', { kind: 'utility_bill' }, 9);
    await rule('Olivia', 'northgate dental', { person: m.Olivia }, 9);
    const got = await withSystem(db, hh, (trx) => learnedContext(trx, hh, m.Ahmed as string));
    expect(got).toEqual({
      rules: [
        {
          issuer_key: 'northgate dental',
          field: 'type_key',
          value: 'medical_record',
          confirmed: 3,
          contradicted: 0,
        },
      ],
      role: 'adult',
      me: m.Ahmed,
    });
    // Somebody with no sign-in has none; nor does a member no longer adding.
    expect(
      await withSystem(db, hh, (trx) => learnedContext(trx, hh, m['Granny Ruth'] as string)),
    ).toBeNull();
  }, 60_000);

  it('a teen’s rule never proposes another person; a hidden kind is never proposed', async () => {
    await forget();
    await rule('Zain', 'northgate dental', { kind: 'medical_record' });
    await rule('Zain', 'northgate dental', { person: m.Sara }, 9);
    const zain = await readFor('Zain', DENTIST);
    expect(zain.proposal.type_key).toMatchObject({ value: 'medical_record', cue: 'learned' });
    expect(zain.proposal.owner_member_id).toBeUndefined();
    expect(zain.clash).toEqual({});
    // A kind the household hides is no proposal, learned or not.
    await forget();
    await admin.query(
      "insert into document_type_setting (household_id, type_key, hidden) values ($1, 'pet_record', true)",
      [hh],
    );
    await rule('Ahmed', 'northgate dental', { kind: 'pet_record' });
    const hidden = await readFor('Ahmed', DENTIST);
    expect(hidden.proposal.type_key).toBeUndefined();
    await admin.query(
      "delete from document_type_setting where household_id = $1 and type_key = 'pet_record'",
      [hh],
    );
  }, 60_000);

  it('an Only me document’s issuer, learned by its owner, never reaches anybody else’s proposals', async () => {
    await forget();
    // Sara's Only me letters from her clinic: her rule says they are hers.
    await admin.query(
      `insert into document (household_id, title, issued_by, visibility, owner_member_id, type_key)
       values ($1, 'Clinic', 'Quietwater Clinic', 'private', $2, 'medical_record')`,
      [hh, m.Sara],
    );
    await rule('Sara', 'quietwater clinic', { kind: 'medical_record' }, 8);
    await rule('Sara', 'quietwater clinic', { person: m.Sara }, 8);
    const letter = ['Quietwater Clinic', 'Dear patient,', 'Your results are ready.'].join('\n');
    const sara = await readFor('Sara', letter);
    expect(sara.proposal).toMatchObject({
      issued_by: { value: 'Quietwater Clinic', cue: 'known_issuer' },
      owner_member_id: { value: m.Sara, cue: 'learned' },
    });
    // Ahmed's letter from the same clinic: nothing of hers — not its kind,
    // not her, not even that it is one of the household's issuers.
    const ahmed = await readFor('Ahmed', letter);
    expect(ahmed.proposal.owner_member_id).toBeUndefined();
    expect(ahmed.proposal.type_key).toBeUndefined();
    expect(ahmed.proposal.issued_by?.cue).not.toBe('known_issuer');
    expect(JSON.stringify(ahmed)).not.toContain(m.Sara as string);
    expect(JSON.stringify(ahmed)).not.toContain('learned');
  }, 60_000);

  it('a rule is sure only once confirmed three times and never contradicted', async () => {
    for (const [confirmed, contradicted, sure] of [
      [2, 0, false],
      [3, 0, true],
      [4, 1, false],
    ] as const) {
      await forget();
      await rule('Ahmed', 'northgate dental', { kind: 'medical_record' }, confirmed, contradicted);
      const got = await readFor('Ahmed', DENTIST);
      expect({ confirmed, contradicted, c: got.proposal.type_key?.confidence }).toEqual({
        confirmed,
        contradicted,
        c: sure ? LEARNED_SURE_CONFIDENCE : LEARNED_CONFIDENCE,
      });
    }
  }, 60_000);

  it('a sure rule never overrides a confident page that disagrees: the pages stand, and both are said', async () => {
    await forget();
    const passport = (TUNED.find((f) => f.name === 'uk-passport-sara') as ProposalFixture).text;
    // The issuer the passport names, ruled to be a visa, and Ahmed's.
    const first = await readFor('Ahmed', passport);
    const issuer = first.proposal.issued_by?.value as string;
    expect(first.proposal.type_key).toMatchObject({ value: 'passport' });
    await rule('Ahmed', issuer.toLowerCase(), { kind: 'visa' }, 5);
    await rule('Ahmed', issuer.toLowerCase(), { person: m.Ahmed }, 5);
    const got = await readFor('Ahmed', passport);
    expect(got.proposal.type_key).toEqual(first.proposal.type_key);
    expect(got.proposal.owner_member_id).toEqual(first.proposal.owner_member_id);
    expect(got.clash).toEqual({ type_key: 'visa', owner_member_id: m.Ahmed });
  }, 60_000);

  /**
   * 5.37's fixtures read, as an uploader would meet them: read, then each
   * accepted as a person would file it — its kind, whose it is and who
   * issued it as they truly are — so every difference from what was
   * proposed is a correction; then read again. The second reading is
   * reported twice: with only the documents those accepts filed (the
   * household's issuers grow: I2's own), and with the rules their
   * corrections taught too. Then the same letters accepted and read again,
   * twice more, as next month's would be: a rule is sure only once
   * confirmed three times. A Ready item must be right, every time.
   */
  it('5.37’s fixtures, before and after learning: no Ready item is wrong', async () => {
    await forget();
    const kinds = await withSystem(db, hh, (trx) =>
      trx
        .selectFrom('effective_document_type')
        .selectAll()
        .where('deleted_at', 'is', null)
        .execute(),
    );
    const types: LevelKind[] = kinds.map((t) => ({
      key: t.key,
      label: t.label,
      default_visibility: t.default_visibility,
      expiry_driver: t.expiry_driver,
      core: t.core as NonNullable<LevelKind['core']>,
      fields: ((t.fields ?? []) as TypeField[]).map((f) => ({
        ...f,
        required: f.required === true || f.key === t.remind_from,
      })),
    }));
    const people = ['Olivia', 'Sara', 'Ahmed', 'Zain', 'Granny Ruth'].map((n) => ({
      id: m[n] as string,
      name: n,
    }));
    const byFixtureId: Record<string, string> = {
      'm-sara': m.Sara as string,
      'm-ahmed': m.Ahmed as string,
      'm-zain': m.Zain as string,
      'm-ruth': m['Granny Ruth'] as string,
    };
    // As in I2's run: the fixtures' issuers on documents everybody sees.
    for (const iss of FIXTURE_ISSUERS) {
      for (let n = 0; n < iss.count; n++) {
        await admin.query(
          'insert into document (household_id, title, issued_by, type_key) values ($1, $2, $3, $4)',
          [hh, `${iss.value} ${n}`, iss.value, iss.typeKeys?.[0] ?? null],
        );
      }
    }
    const fixtures: Array<[string, ProposalFixture]> = [
      ...TUNED.map((f) => ['tuned', f] as [string, ProposalFixture]),
      ...HELD_OUT.map((f) => ['held out', f] as [string, ProposalFixture]),
    ];
    const level = (proposal: DetailProposal, clash: LearnedClash) =>
      levelItem({
        state: 'waiting',
        reading: 'read',
        failure: null,
        proposal,
        learnedClash: clash,
        duplicate: null,
        defaults: {
          owner_member_id: null,
          type_key: null,
          visibility: null,
          physical_location: null,
          collection_id: null,
          tags: [],
          is_essential: false,
        },
        types,
        people,
        role: 'adult',
        me: m.Ahmed as string,
      });
    const wrongReady: string[] = [];
    /** One reading of them all: levels counted by set; each one's level kept. */
    const pass = async (name: string) => {
      const tally: Record<string, Record<BatchLevel, number>> = {};
      const out = new Map<string, ReturnType<typeof level>>();
      for (const [set, f] of fixtures) {
        const t = (tally[set] ??= { ready: 0, check: 0, unrecognised: 0, problem: 0 });
        const { proposal, clash } = await readFor('Ahmed', f.text);
        const l = level(proposal, clash);
        t[l.level as BatchLevel] += 1;
        out.set(f.name, l);
        if (l.level === 'ready') {
          const kind = l.proposals?.type_key?.value;
          const owner = l.proposals?.owner_member_id?.value;
          if (kind !== f.truth.type_key || owner !== byFixtureId[f.truth.owner ?? '']) {
            wrongReady.push(`${name}: ${f.name}`);
          }
        }
      }
      return { tally, out };
    };

    /**
     * Each accepted as it truly is, in order, as this reading proposed it:
     * what that teaches (as the API teaches it), and the document it files
     * (Ahmed's, for everybody). Answers how many needed no change.
     */
    let rules: KeptRule[] = [];
    let n = 0;
    type Reading = Map<string, ReturnType<typeof level>>;
    const acceptAll = async (reading: Reading) => {
      let unchanged = 0;
      for (const [, f] of fixtures) {
        const filed = {
          type_key: f.truth.type_key,
          owner_member_id: f.truth.owner ? (byFixtureId[f.truth.owner] ?? null) : null,
          issued_by: f.truth.issued_by,
        };
        const proposals = reading.get(f.name)?.proposals ?? null;
        if (
          filed.type_key === (proposals?.type_key?.value ?? null) &&
          filed.owner_member_id === (proposals?.owner_member_id?.value ?? null)
        ) {
          unchanged += 1;
        }
        rules = teach(rules, learningOf({ proposals, filed, role: 'adult' }), {
          newId: () => `r${n++}`,
          today: '2026-10-09',
        }).rules;
        if (f.truth.issued_by) {
          await admin.query(
            `insert into document (household_id, title, issued_by, type_key, owner_member_id, visibility)
             values ($1, $2, $3, $4, $5, 'household')`,
            [hh, f.name, f.truth.issued_by, f.truth.type_key, filed.owner_member_id],
          );
        }
      }
      return unchanged;
    };
    /** The rules as taught so far, kept as the API keeps them: Ahmed's. */
    const keep = async () => {
      await forget();
      for (const r of rules) {
        await rule(
          'Ahmed',
          r.issuer_key,
          r.field === 'type_key' ? { kind: r.value } : { person: r.value },
          r.confirmed,
          r.contradicted,
        );
      }
    };

    const before = await pass('before');
    const unchanged = [await acceptAll(before.out)];
    // The second reading with only what was filed: the household's issuers grow (I2's own)...
    const filedOnly = await pass('filed, no rules');
    // ...and with what the corrections taught.
    await keep();
    const readings = [await pass('learned once')];
    // The same letters again, and again: each accept confirms what was learned.
    for (const name of ['learned twice', 'learned three times']) {
      unchanged.push(await acceptAll((readings.at(-1) as { out: Reading }).out));
      await keep();
      readings.push(await pass(name));
    }
    const council = ['uk-council-tax-ruth', 'uk-council-tax-demand-ruth'].map((f) => {
      const l = readings.at(-1)?.out.get(f);
      return {
        level: l?.level,
        ruth: l?.proposals?.owner_member_id?.value === m['Granny Ruth'],
        from: l?.proposals?.owner_member_id?.from,
      };
    });

    // What the run found (reported with I4). No Ready item is wrong, at any reading.
    expect(wrongReady).toEqual([]);
    expect({
      before: before.tally,
      filedOnly: filedOnly.tally,
      learned: readings.map((r) => r.tally),
      rules: rules.map((r) => `${r.issuer_key} ${r.field} ${r.confirmed}/${r.contradicted}`),
      unchanged,
      council,
    }).toEqual({
      before: {
        tuned: { ready: 13, check: 7, unrecognised: 2, problem: 0 },
        'held out': { ready: 9, check: 3, unrecognised: 2, problem: 0 },
      },
      filedOnly: {
        tuned: { ready: 14, check: 6, unrecognised: 2, problem: 0 },
        'held out': { ready: 10, check: 2, unrecognised: 2, problem: 0 },
      },
      // Learned once and twice: each council's letters are Granny Ruth's — a
      // rule not sure yet, so they stay Check ("Person unsure").
      learned: [
        {
          tuned: { ready: 14, check: 6, unrecognised: 2, problem: 0 },
          'held out': { ready: 10, check: 2, unrecognised: 2, problem: 0 },
        },
        {
          tuned: { ready: 14, check: 6, unrecognised: 2, problem: 0 },
          'held out': { ready: 10, check: 2, unrecognised: 2, problem: 0 },
        },
        // Confirmed a third time, never contradicted: sure, and Ready — right.
        {
          tuned: { ready: 15, check: 5, unrecognised: 2, problem: 0 },
          'held out': { ready: 11, check: 1, unrecognised: 2, problem: 0 },
        },
      ],
      rules: [
        'london borough of camden owner_member_id 3/0',
        'london borough of lewisham owner_member_id 3/0',
      ],
      // Of 36, how many had their kind and person accepted as proposed.
      unchanged: [34, 36, 36],
      council: [
        { level: 'ready', ruth: true, from: 'learned' },
        { level: 'ready', ruth: true, from: 'learned' },
      ],
    });
  }, 300_000);
});
