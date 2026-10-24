import type { BatchLevel } from './batch-levels.js';
import {
  scoreItem,
  summarise,
  type SmartCounts,
  type SmartEntry,
  type SmartMiss,
  type SmartScore,
  type SmartSeen,
} from './reading-score.js';

/**
 * The Reading check (0.9.0, R0): the vault's current reader measured on a
 * family's own papers, without a word of them leaving the vault.
 *
 * An owner asks for it in Settings → For owners. The worker re-reads, at a
 * low priority, the last N documents filed through review — a batch's item
 * or an Inbox file somebody accepted, so a person confirmed its details —
 * that the owner can see out of the Trash: never somebody else's Only me.
 * Each is read as a batch's item would be (its current version's words,
 * `proposeDetails`, `levelItem`, with no folder names), twice: without the
 * learned rules (I4), the honest number, and with the asking owner's own
 * rules on the documents they filed themselves ("your learning, on the
 * documents you filed"), which is optimistic, since the rules were learned
 * from these same papers; on anybody else's, with is without. What it offered is scored against the document's details
 * now (kind, whose, and the expiry where the kind keeps one) by the Smart
 * exit's own scorer (reading-score.ts: `scoreItem`, `summarise`).
 *
 * What is kept is numbers only: how many were Ready, Check, Not recognised
 * or not read, how many need typing and how many are a wrong Ready, by
 * kind, both readings, with the reader's version (the server's, and a keyed
 * hash of the rules) — so a later check can be compared with an earlier
 * one. A check, its numbers and its misses are the asking owner's alone
 * (the owner's decision, R0 review): another owner is told only that one of
 * theirs is waiting, running or finished, and whose (ReadingCheckOther).
 * Which documents needed typing, and which field, is kept sealed under the
 * owner's own key for READING_MISSES_KEEP_DAYS, and shown only for documents
 * they can still see. Nothing is written to a document, and no item,
 * proposal or rule is made.
 */

/** How many documents a check re-reads: the last N filed through review. */
export const READING_CHECK_N = { default: 50, min: 10, max: 500 } as const;

/** How long the per-document misses are kept, sealed, for the owner who ran the check. */
export const READING_MISSES_KEEP_DAYS = 7;

/**
 * A check's course: waiting for the worker, running, done; or cancelled by
 * an owner, or failed (the worker could not finish it: `failure` says why).
 */
export type ReadingCheckState = 'waiting' | 'running' | 'done' | 'cancelled' | 'failed';

/** Why a check failed, as a word. */
export type ReadingCheckFailure = 'stopped' | 'restored';

/** One reading's numbers over some documents. */
export interface ReadingCounts {
  documents: number;
  ready: number;
  check: number;
  unrecognised: number;
  problem: number;
  /** Not read at all: the pages gave no words (an OCR failure, a file the vault does not read). */
  not_read: number;
  /** Something a person must have right was missing or wrong (`scoreItem`'s manual). */
  needs_typing: number;
  /** Ready, and its kind, person or expiry wrong: what Accept all Ready would file unseen. */
  wrong_ready: number;
  /** Ready, with an issue date, number or issuer that is not the document's. */
  ready_detail_wrong: number;
  /** A kind that asks for an expiry, a document without one, and none offered. */
  expiry_not_on_paper: number;
  /** Of those needing typing, how many needed each field. */
  kind_typed: number;
  person_typed: number;
  expiry_typed: number;
}

/** One kind's numbers. */
export interface ReadingKindRow {
  documents: number;
  /** The kind offered is the document's. */
  kind_right: number;
  /** Nothing to type: kind, person and expiry all right. */
  no_typing: number;
}

/**
 * One reading of the check's documents: all of them, those read from a
 * PDF's own text and those that needed OCR, and by kind. Only me documents
 * are counted by kind as `(only_me)`, never by their kind.
 */
export interface ReadingResult {
  all: ReadingCounts;
  text: ReadingCounts;
  scan: ReadingCounts;
  by_kind: Record<string, ReadingKindRow>;
}

/** The by-kind row of the requester's own Only me documents. */
export const ONLY_ME_KIND = '(only_me)';

/** A check's numbers: numbers only, nothing else (`numbersOnly`). */
export interface ReadingCheckSummary {
  /** Documents chosen when it started. */
  chosen: number;
  /** Re-read and scored. */
  read: number;
  /** Left out as it ran: removed, moved to the Trash, or no longer the requester's to see. */
  skipped: number;
  /** Changed by hand since they were filed: their details now are the truth. */
  edited: number;
  /**
   * Read with some detail not confirmed by a person — an Inbox file, or a
   * version added to a document already there, confirms only what its
   * accept set — and so not scored: never a miss.
   */
  partly_confirmed: number;
  /** Read without the learned rules: the honest number. */
  without_rules: ReadingResult;
  /**
   * Read with the asking owner's own learned rules on the documents they
   * filed themselves — optimistic, learned from these same papers. On a
   * document somebody else filed it is the reading without: no owner's
   * numbers reflect another person's rules.
   */
  with_rules: ReadingResult;
}

/** The reader a check measured: the server's release, and a keyed hash of the rules it read with. */
export interface ReadingReader {
  server_version: string | null;
  /** Twelve hex characters; the same rules give the same hash. Null before it ran. */
  rules: string | null;
}

/** GET /reading-checks: a check, as the owner who asked sees it (theirs alone). */
/**
 * The household's reading settings (0.9.0, R2): GET and PUT
 * /household/reading, an owner's. `reading_model`: whether the vault's
 * reading model reads a batch's pages beside the rules (on unless an owner
 * turned it off).
 */
export interface ReadingSettings {
  reading_model: boolean;
  /**
   * Whether the worker has the model's weights loaded, as it last said
   * (the R2 review): false, the rules read alone whatever the switch says.
   * Answered, never sent.
   */
  loaded?: boolean;
}

export interface ReadingCheckView {
  id: string;
  state: ReadingCheckState;
  failure: ReadingCheckFailure | null;
  /** The N asked for. */
  n: number;
  include_edited: boolean;
  /** Who started it, by the name the household knows them by. */
  requested_by: { member_id: string | null; name: string | null };
  /** Started by the caller: always, since 0.9.0's review (a check is its asker's alone). */
  mine: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: { total: number; done: number };
  reader: ReadingReader;
  summary: ReadingCheckSummary | null;
}

/** A document that needed typing, as its owner who ran the check is shown it. */
export interface ReadingMissView {
  document_id: string;
  /** As the requester sees it now. */
  title: string | null;
  type_key: string | null;
  /** What needed typing, read without the learned rules. */
  fields: SmartMiss[];
  level: BatchLevel | null;
  wrong_ready: boolean;
}

/** GET /reading-checks/{id}: the check, and the caller's own misses while they are kept. */
export interface ReadingCheckDetail extends ReadingCheckView {
  /** The caller's own check's misses, for documents they can still see; null for anybody else's, or once gone. */
  misses: ReadingMissView[] | null;
  /** When the misses go. */
  misses_until: string | null;
}

/**
 * Another owner's check, as an owner is told of it (the owner's decision,
 * R0 review): that it is waiting, running or finished, whose, and when —
 * never its numbers. One runs at a time, so this says why another can't
 * start. Only its owner cancels or removes it.
 */
export interface ReadingCheckOther {
  state: ReadingCheckState;
  requested_by: { member_id: string | null; name: string | null };
}

/** GET /reading-checks. */
export interface ReadingChecksList {
  /** The caller's own checks, newest first. */
  items: ReadingCheckView[];
  /** The household's other owners' checks, without their numbers. */
  others: ReadingCheckOther[];
  /** Documents filed through review the caller can see, out of the Trash: the most a check can read. */
  filed: number;
}

/** POST /reading-checks. */
export interface ReadingCheckInput {
  n?: number | undefined;
  include_edited?: boolean | undefined;
}

/** What is sealed for each document needing typing. */
export interface ReadingMiss {
  document_id: string;
  fields: SmartMiss[];
  level: BatchLevel | null;
  wrong_ready: boolean;
}

/** A document's details now: the truth it is scored against. */
export interface ReadingTruth {
  kind: string | null;
  person: string | null;
  issued: string | null;
  expires: string | null;
  number: string | null;
  issuer: string | null;
}

/** One document, read once. */
export interface ReadingRow {
  document_id: string;
  /** Only me: counted by kind as ONLY_ME_KIND. */
  only_me: boolean;
  /** Its words from a PDF's own text, or OCR (or neither, unread). */
  mode: 'text' | 'scan';
  truth: ReadingTruth;
  seen: SmartSeen;
  /**
   * The details a person confirmed: as it was filed through review, and
   * since by hand. Left out, every one. A detail not confirmed is not
   * scored: what was offered for it is taken as right.
   */
  confirmed?: readonly ReadingField[];
}

/** A detail a person may have confirmed, as the scorer names them. */
export type ReadingField = 'kind' | 'person' | 'expiry' | 'issued' | 'number' | 'issuer';
export const READING_FIELDS: readonly ReadingField[] = [
  'kind',
  'person',
  'expiry',
  'issued',
  'number',
  'issuer',
];
/** The details whose miss is typing: a document with none of them confirmed is not read. */
export const READING_SCORED_FIELDS: readonly ReadingField[] = ['kind', 'person', 'expiry'];

/** The seen value of each field, by the scorer's name for the truth's. */
const SEEN_OF: Readonly<Record<ReadingField, keyof SmartSeen & keyof ReadingTruth>> = {
  kind: 'kind',
  person: 'person',
  expiry: 'expires',
  issued: 'issued',
  number: 'number',
  issuer: 'issuer',
};

/**
 * What was offered, with every detail a person did not confirm taken as
 * the document's: not scored, never a miss.
 */
export function confirmedOnly(row: Pick<ReadingRow, 'truth' | 'seen' | 'confirmed'>): SmartSeen {
  if (!row.confirmed) return row.seen;
  const seen = { ...row.seen };
  for (const f of READING_FIELDS) {
    if (row.confirmed.includes(f)) continue;
    const k = SEEN_OF[f];
    (seen as Record<string, unknown>)[k] = row.truth[k];
  }
  return seen;
}

/** A document as the Smart exit's scorer takes a corpus file: the truth is its details now. */
export function readingEntry(row: Pick<ReadingRow, 'document_id' | 'mode' | 'truth'>): SmartEntry {
  return {
    path: row.document_id,
    paper: '',
    set: 'tune',
    mode: row.mode,
    blank: false,
    duplicate_of: null,
    rescan_of: null,
    misfiled: false,
    folder: null,
    // "Something else" is a paper of no kind the vault keeps, as the corpus has it.
    truth: { ...row.truth, kind: row.truth.kind === 'other' ? null : row.truth.kind },
  };
}

const counts = (c: SmartCounts, typed: Record<SmartMiss, number>): ReadingCounts => ({
  documents: c.files,
  ready: c.ready,
  check: c.check,
  unrecognised: c.unrecognised,
  problem: c.problem,
  not_read: c.unread,
  needs_typing: c.manual,
  wrong_ready: c.wrong_ready,
  ready_detail_wrong: c.ready_detail_wrong,
  expiry_not_on_paper: c.expiry_not_on_paper,
  kind_typed: typed.kind,
  person_typed: typed.person,
  expiry_typed: typed.expiry,
});

/**
 * One reading scored: each document by `scoreItem`, the numbers by
 * `summarise` — the Smart exit's own, unchanged — and the misses for the
 * sealed list. `expiring`: whether a kind keeps an expiry.
 */
export function scoreReading(
  rows: readonly ReadingRow[],
  expiring: (kind: string) => boolean,
): { result: ReadingResult; misses: ReadingMiss[] } {
  const scored = rows.map((r) => {
    const entry = readingEntry(r);
    const seen = confirmedOnly(r);
    return { row: r, entry, seen, score: scoreItem(entry, seen, expiring) };
  });
  const s = summarise(scored);
  const typedIn = (want: (r: (typeof scored)[number]) => boolean) => {
    const t: Record<SmartMiss, number> = { kind: 0, person: 0, expiry: 0 };
    for (const x of scored) if (want(x)) for (const m of x.score.misses) t[m] += 1;
    return t;
  };
  const by_kind: Record<string, ReadingKindRow> = {};
  for (const x of scored) {
    const k = x.row.only_me ? ONLY_ME_KIND : (x.entry.truth.kind ?? '(none)');
    const row = (by_kind[k] ??= { documents: 0, kind_right: 0, no_typing: 0 });
    row.documents += 1;
    if (!x.score.misses.includes('kind')) row.kind_right += 1;
    if (!x.score.manual) row.no_typing += 1;
  }
  const missOf = (x: { row: ReadingRow; seen: SmartSeen; score: SmartScore }): ReadingMiss => ({
    document_id: x.row.document_id,
    fields: x.score.misses,
    level: x.seen.level,
    wrong_ready: x.score.wrongReady,
  });
  return {
    result: {
      all: counts(
        s.all,
        typedIn(() => true),
      ),
      text: counts(
        s.text,
        typedIn((x) => x.row.mode === 'text'),
      ),
      scan: counts(
        s.scan,
        typedIn((x) => x.row.mode === 'scan'),
      ),
      by_kind,
    },
    misses: scored.filter((x) => x.score.manual).map(missOf),
  };
}

/** A by-kind key: a kind's key, or one of the summary's own rows. */
const KEY = /^[a-z0-9_()-]{1,64}$/;

/**
 * Whether `value` is numbers only: objects whose keys are plain words (a
 * kind's key, a count's name) and whose leaves are whole numbers, nothing
 * else — no string, no list, no null. What is kept and printed of a check,
 * held here, in the API, in the worker's CLI and by the database (0074).
 */
export function numbersOnly(value: unknown, depth = 0): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (depth > 4 || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).every(
    ([k, v]) => KEY.test(k) && numbersOnly(v, depth + 1),
  );
}

/**
 * What changed since an earlier check, in words: "Since 0.9.0-dev.2: needs
 * typing 18 → 11; wrong Ready 0 → 0" — the honest reading's, each over the
 * documents its check read. Null when either has no numbers.
 */
export function readingComparison(
  earlier: Pick<ReadingCheckView, 'summary' | 'reader' | 'created_at'>,
  later: Pick<ReadingCheckView, 'summary'>,
): string | null {
  if (!earlier.summary || !later.summary) return null;
  const a = earlier.summary.without_rules.all;
  const b = later.summary.without_rules.all;
  const since = earlier.reader.server_version ?? earlier.created_at.slice(0, 10);
  const out = `Since ${since}: needs typing ${a.needs_typing} → ${b.needs_typing}; wrong Ready ${a.wrong_ready} → ${b.wrong_ready}`;
  return a.documents === b.documents ? out : `${out} (of ${a.documents} then, ${b.documents} now)`;
}
