import { describe, expect, it } from 'vitest';
import {
  numbersOnly,
  ONLY_ME_KIND,
  readingComparison,
  readingEntry,
  scoreReading,
  type ReadingCheckSummary,
  type ReadingRow,
} from './reading-check.js';
import { scoreItem, summarise, type SmartEntry, type SmartSeen } from './testdata/index.js';
import {
  FIXTURE_KINDS,
  HELD_OUT,
  TUNED,
  type ProposalFixture,
} from './testdata/proposal-fixtures.js';

/**
 * The Reading check's scoring (0.9.0, R0): the Smart exit's own scorer,
 * the same one (testdata/smart-exit.ts re-exports reading-score.ts), run on
 * a family's documents — each document's details now as the truth — and
 * numbers only kept.
 */

const EXPIRING = new Set(FIXTURE_KINDS.filter((k) => k.expiry_driver).map((k) => k.key));
const expiring = (k: string) => EXPIRING.has(k);

/** A corpus fixture as a filed document: its truth is what the family filed. */
const truthOf = (f: ProposalFixture) => ({
  kind: f.truth.type_key,
  person: f.truth.owner,
  issued: f.truth.issued,
  expires: f.truth.expires,
  number: f.truth.identifier,
  issuer: f.truth.issued_by,
});

/** What a reader might have offered for it: right, or wrong in one way, by turns. */
const offered = (f: ProposalFixture, i: number): SmartSeen => {
  const right: SmartSeen = {
    level: 'ready',
    duplicate: false,
    failure: null,
    kind: f.truth.type_key,
    person: f.truth.owner,
    issued: f.truth.issued,
    expires: f.truth.expires,
    number: f.truth.identifier,
    issuer: f.truth.issued_by,
  };
  switch (i % 5) {
    case 1:
      return { ...right, level: 'check', person: null };
    case 2:
      return { ...right, level: 'ready', kind: 'warranty' };
    case 3:
      return { ...right, level: null, kind: null, person: null, expires: null, failure: 'x' };
    case 4:
      return { ...right, level: 'ready', expires: '2099-01-01' };
    default:
      return right;
  }
};

const fixtures = [...TUNED.slice(0, 12), ...HELD_OUT.slice(0, 8)];
const rows: ReadingRow[] = fixtures.map((f, i) => ({
  document_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  only_me: false,
  mode: i % 3 === 0 ? 'scan' : 'text',
  truth: truthOf(f),
  seen: offered(f, i),
}));

describe('the Reading check scores as the Smart exit does', () => {
  it('each document by scoreItem, the numbers by summarise: the same counts, on the corpus fixtures', () => {
    const { result, misses } = scoreReading(rows, expiring);
    // The corpus scorer run straight on the same documents.
    const direct = rows.map((r) => {
      const entry: SmartEntry = readingEntry(r);
      return { entry, seen: r.seen, score: scoreItem(entry, r.seen, expiring) };
    });
    const s = summarise(direct);
    for (const [mine, theirs] of [
      [result.all, s.all],
      [result.text, s.text],
      [result.scan, s.scan],
    ] as const) {
      expect(mine).toMatchObject({
        documents: theirs.files,
        ready: theirs.ready,
        check: theirs.check,
        unrecognised: theirs.unrecognised,
        problem: theirs.problem,
        not_read: theirs.unread,
        needs_typing: theirs.manual,
        wrong_ready: theirs.wrong_ready,
        ready_detail_wrong: theirs.ready_detail_wrong,
        expiry_not_on_paper: theirs.expiry_not_on_paper,
      });
    }
    for (const [k, row] of Object.entries(s.by_kind)) {
      expect(result.by_kind[k]).toEqual({
        documents: row.files,
        kind_right: row.kind_right,
        no_typing: row.no_typing,
      });
    }
    // And the misses are its manual list, by document.
    expect(misses.map((m) => m.document_id)).toEqual(s.manual.map((m) => m.path));
    expect(misses.map((m) => m.fields)).toEqual(s.manual.map((m) => m.misses));
    expect(misses.filter((m) => m.wrong_ready).map((m) => m.document_id)).toEqual(s.wrong_ready);
    // Some of each, so the comparison is worth something.
    expect(result.all.needs_typing).toBeGreaterThan(0);
    expect(result.all.wrong_ready).toBeGreaterThan(0);
    expect(result.all.not_read).toBeGreaterThan(0);
    expect(result.all.documents - result.all.needs_typing).toBeGreaterThan(0);
    // Which fields needed typing, summed.
    expect(result.all.kind_typed + result.all.person_typed + result.all.expiry_typed).toBe(
      misses.reduce((n, m) => n + m.fields.length, 0),
    );
  });

  it('“Something else” is a paper of no kind, as the corpus has it', () => {
    const other: ReadingRow = {
      ...(rows[0] as ReadingRow),
      truth: { ...(rows[0] as ReadingRow).truth, kind: 'other' },
      seen: { ...(rows[0] as ReadingRow).seen, level: 'unrecognised', kind: null },
    };
    expect(scoreReading([other], expiring).result.all.needs_typing).toBe(0);
  });

  it('an Only me document is counted, never by its kind', () => {
    const mine: ReadingRow = { ...(rows[0] as ReadingRow), only_me: true };
    const { result } = scoreReading([mine], expiring);
    expect(Object.keys(result.by_kind)).toEqual([ONLY_ME_KIND]);
    expect(result.all.documents).toBe(1);
  });
});

describe('only what a person confirmed is scored (the R0 review, A-2)', () => {
  const base = rows[0] as ReadingRow;
  const wrongPerson: ReadingRow = {
    ...base,
    seen: { ...base.seen, level: 'ready', person: 'somebody-else' },
  };
  it('an Inbox file whose accept set its kind alone: whose it is, offered wrong, is no miss', () => {
    // Every detail confirmed (a batch's): the wrong person needs typing.
    expect(scoreReading([wrongPerson], expiring).misses.map((m) => m.fields)).toEqual([['person']]);
    // Its kind alone confirmed: the person is not scored.
    const inbox: ReadingRow = { ...wrongPerson, confirmed: ['kind'] };
    expect(scoreReading([inbox], expiring).misses).toEqual([]);
    // A wrong kind is still a miss.
    const wrongKind: ReadingRow = {
      ...inbox,
      seen: { ...inbox.seen, kind: 'warranty' },
    };
    expect(scoreReading([wrongKind], expiring).misses.map((m) => m.fields)).toEqual([['kind']]);
  });
});

describe('numbers only', () => {
  it('a summary is numbers only; a name, a value, a list or a null is not', () => {
    const { result } = scoreReading(rows, expiring);
    const summary: ReadingCheckSummary = {
      chosen: 20,
      read: 20,
      skipped: 0,
      edited: 0,
      partly_confirmed: 0,
      without_rules: result,
      with_rules: result,
    };
    expect(numbersOnly(summary)).toBe(true);
    for (const bad of [
      { ...summary, chosen: 'Sara' },
      { ...summary, note: ['x'] },
      { ...summary, chosen: null },
      { ...summary, chosen: 1.5 },
      { ...summary, chosen: -1 },
      { ...summary, 'Sara’s passport': 1 },
      { a: { b: { c: { d: { e: { f: 1 } } } } } },
      'twelve',
      [1, 2],
    ]) {
      expect(numbersOnly(bad)).toBe(false);
    }
  });
});

describe('comparing with an earlier check', () => {
  const at = (needs: number, wrong: number, documents = 50) =>
    ({
      chosen: documents,
      read: documents,
      skipped: 0,
      edited: 0,
      without_rules: {
        all: { documents, needs_typing: needs, wrong_ready: wrong },
      },
    }) as unknown as ReadingCheckSummary;
  it('says what changed since that reader, in its own numbers', () => {
    expect(
      readingComparison(
        {
          summary: at(18, 1),
          reader: { server_version: '0.9.0-dev.2', rules: 'abcdefabcdef' },
          created_at: '2026-10-17T10:00:00.000Z',
        },
        { summary: at(11, 0) },
      ),
    ).toBe('Since 0.9.0-dev.2: needs typing 18 → 11; wrong Ready 1 → 0');
    expect(
      readingComparison(
        {
          summary: at(18, 0, 40),
          reader: { server_version: null, rules: null },
          created_at: '2026-10-17T10:00:00.000Z',
        },
        { summary: at(11, 0) },
      ),
    ).toBe('Since 2026-10-17: needs typing 18 → 11; wrong Ready 0 → 0 (of 40 then, 50 now)');
    expect(
      readingComparison(
        { summary: null, reader: { server_version: null, rules: null }, created_at: '' },
        { summary: at(1, 0) },
      ),
    ).toBeNull();
  });
});
