/**
 * How the Smart exit (0.8.0, S5) scores the vault on its corpus
 * (scripts/smart-corpus.mjs): each paper's truth — what a person would fill
 * in — against what its card starts from once the vault has read it (the
 * batch item's `level` and `proposals`, as GET /batches/{id} gives them).
 *
 * **Needs manual typing**: after accepting what the card offers, a field a
 * person must have right is missing or wrong:
 *
 * - **the kind** — for a paper of no kind the vault keeps (a menu, a
 *   newsletter), any kind offered but "Something else" is wrong, and none
 *   is right: the card says Not recognised, and the person keeps or bins it;
 * - **whose it is** — someone offered where the paper is nobody's (a till
 *   receipt), or not the one it is;
 * - **the expiry**, for a kind that has one, where the paper says it: an
 *   expiry offered that is not the paper's is wrong wherever it is offered.
 *   Where a kind keeps an expiry and the paper gives none, nothing can be
 *   read: that is not the reader's miss, and is counted apart
 *   (`expiry_not_on_paper`) only where the kind still asks for the date —
 *   not a will's, a logbook's, a contract's or a deed's, which since 0.8.0
 *   are the family's to add (EXPIRY_OPTIONAL_KINDS).
 *
 * A blank page and the later of two copies with the same bytes need nothing
 * typed when the vault says Problem (blank, duplicate): the person removes
 * them. An item at Check whose suggestions are all right needs a click, not
 * typing.
 *
 * **Wrong Ready**: Ready, and its kind, person or expiry wrong — what Accept
 * all Ready would file unseen. It must be none. A Ready item whose issue
 * date, number or issuer is not the paper's is counted beside it
 * (`ready_detail_wrong`): filed, but no field a person must have.
 */
import type { BatchLevel } from '../batch-levels.js';
import { expiryOptional } from '../documents.js';

export interface SmartTruth {
  kind: string | null;
  person: string | null;
  issued: string | null;
  expires: string | null;
  number: string | null;
  issuer: string | null;
}

/** A file of the corpus, as its manifest gives it. */
export interface SmartEntry {
  path: string;
  paper: string;
  set: 'tune' | 'held-out';
  mode: 'text' | 'scan';
  blank: boolean;
  duplicate_of: string | null;
  rescan_of: string | null;
  misfiled: boolean;
  folder: string | null;
  truth: SmartTruth;
}

/** What the vault made of it: its level, and what its card starts from (people by their corpus key). */
export interface SmartSeen {
  level: BatchLevel | null;
  duplicate: boolean;
  failure: string | null;
  kind: string | null;
  person: string | null;
  issued: string | null;
  expires: string | null;
  number: string | null;
  issuer: string | null;
}

export type SmartMiss = 'kind' | 'person' | 'expiry';

export interface SmartScore {
  manual: boolean;
  /** What a person would have to type or choose. */
  misses: SmartMiss[];
  wrongReady: boolean;
  /** Ready, with an issue date, number or issuer that is not the paper's. */
  readyDetailWrong: Array<'issued' | 'number' | 'issuer'>;
  /** A kind with an expiry, a paper without one, and none offered. */
  expiryNotOnPaper: boolean;
}

const bare = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/** An issuer is right when one name begins with the other ("Harbourline Bank" for "Harbourline"). */
export function sameIssuer(got: string, want: string): boolean {
  const a = bare(got.replace(/\b(?:plc|ltd|limited|llp|inc)\b\.?/gi, ''));
  const b = bare(want.replace(/\b(?:plc|ltd|limited|llp|inc)\b\.?/gi, ''));
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
}

/** A number is right with its spaces ignored. */
export const sameNumber = (got: string, want: string) =>
  got.replace(/\s/g, '').toUpperCase() === want.replace(/\s/g, '').toUpperCase();

/**
 * One paper scored. `expiring`: whether a kind keeps an expiry (its
 * `expiry_driver`), as the household's kinds say.
 */
export function scoreItem(
  entry: SmartEntry,
  seen: SmartSeen,
  expiring: (kind: string) => boolean,
): SmartScore {
  const none: SmartScore = {
    manual: false,
    misses: [],
    wrongReady: false,
    readyDetailWrong: [],
    expiryNotOnPaper: false,
  };
  const t = entry.truth;
  // Blank, or a copy the vault says is one: removed, nothing typed.
  if (entry.blank && (seen.level === 'problem' || seen.kind === null)) return none;
  if (entry.duplicate_of && seen.level === 'problem' && seen.duplicate) return none;

  const misses: SmartMiss[] = [];
  const kindRight =
    t.kind === null ? seen.kind === null || seen.kind === 'other' : seen.kind === t.kind;
  if (!kindRight) misses.push('kind');
  if (t.kind !== null) {
    if (seen.person !== t.person) misses.push('person');
    if (expiring(t.kind) && seen.expires !== t.expires) misses.push('expiry');
  }
  // Nothing to read: a kind with an expiry, the paper giving none and none
  // offered. Counted apart where the kind still asks for the date; nowhere
  // where it is the family's to add (EXPIRY_OPTIONAL_KINDS, 0.8.0).
  const nothingToRead =
    t.kind !== null && kindRight && expiring(t.kind) && t.expires === null && seen.expires === null;
  const expiryNotOnPaper = nothingToRead && !expiryOptional({ key: t.kind });
  const readyDetailWrong: SmartScore['readyDetailWrong'] = [];
  if (seen.level === 'ready') {
    if (seen.issued !== null && seen.issued !== t.issued) readyDetailWrong.push('issued');
    if (seen.number !== null && (t.number === null || !sameNumber(seen.number, t.number))) {
      readyDetailWrong.push('number');
    }
    if (seen.issuer !== null && (t.issuer === null || !sameIssuer(seen.issuer, t.issuer))) {
      readyDetailWrong.push('issuer');
    }
  }
  // Nothing to read is not a reading's miss (see above).
  const counted = nothingToRead ? misses.filter((m) => m !== 'expiry') : misses;
  return {
    manual: counted.length > 0,
    misses: counted,
    wrongReady: seen.level === 'ready' && counted.length > 0,
    readyDetailWrong,
    expiryNotOnPaper,
  };
}

export interface SmartCounts {
  files: number;
  ready: number;
  check: number;
  unrecognised: number;
  problem: number;
  /** Not read at all: no level. */
  unread: number;
  manual: number;
  wrong_ready: number;
  ready_detail_wrong: number;
  expiry_not_on_paper: number;
}

export interface SmartKindRow {
  files: number;
  /** The kind offered is the paper's. */
  kind_right: number;
  /** Nothing to type: kind, person and expiry all right. */
  no_typing: number;
}

export interface SmartSummary {
  all: SmartCounts;
  tune: SmartCounts;
  held_out: SmartCounts;
  text: SmartCounts;
  scan: SmartCounts;
  by_kind: Record<string, SmartKindRow>;
  /** Each paper needing typing: where it is, and what. */
  manual: Array<{ path: string; set: string; misses: SmartMiss[]; level: BatchLevel | null }>;
  wrong_ready: string[];
}

const empty = (): SmartCounts => ({
  files: 0,
  ready: 0,
  check: 0,
  unrecognised: 0,
  problem: 0,
  unread: 0,
  manual: 0,
  wrong_ready: 0,
  ready_detail_wrong: 0,
  expiry_not_on_paper: 0,
});

/** The numbers of a run: all, each set, text and scans, and by kind. */
export function summarise(
  rows: ReadonlyArray<{ entry: SmartEntry; seen: SmartSeen; score: SmartScore }>,
): SmartSummary {
  const out: SmartSummary = {
    all: empty(),
    tune: empty(),
    held_out: empty(),
    text: empty(),
    scan: empty(),
    by_kind: {},
    manual: [],
    wrong_ready: [],
  };
  for (const { entry, seen, score } of rows) {
    for (const c of [
      out.all,
      entry.set === 'tune' ? out.tune : out.held_out,
      entry.mode === 'text' ? out.text : out.scan,
    ]) {
      c.files += 1;
      if (seen.level === null) c.unread += 1;
      else c[seen.level] += 1;
      if (score.manual) c.manual += 1;
      if (score.wrongReady) c.wrong_ready += 1;
      if (score.readyDetailWrong.length > 0) c.ready_detail_wrong += 1;
      if (score.expiryNotOnPaper) c.expiry_not_on_paper += 1;
    }
    const k = entry.blank ? '(blank)' : (entry.truth.kind ?? '(none)');
    const row = (out.by_kind[k] ??= { files: 0, kind_right: 0, no_typing: 0 });
    row.files += 1;
    if (!score.misses.includes('kind')) row.kind_right += 1;
    if (!score.manual) row.no_typing += 1;
    if (score.manual) {
      out.manual.push({
        path: entry.path,
        set: entry.set,
        misses: score.misses,
        level: seen.level,
      });
    }
    if (score.wrongReady) out.wrong_ready.push(entry.path);
  }
  return out;
}
