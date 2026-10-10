import type { ItemProposals } from './batch-levels.js';
import type { CaptureMetadata } from './capture.js';
import type { CoreField, CoreFieldRule, DateValue, DocumentTypeView } from './documents.js';
import { issuerKey } from './issuers.js';
import {
  PROPOSAL_THRESHOLDS,
  proposeDetails,
  proposeWithTie,
  type DetailProposal,
  type ProposalContext,
  type ProposalField,
  type ProposalKind,
  type Proposed,
} from './proposals.js';
import type { Role } from './roles.js';

/**
 * The vault learns from your corrections (Phase 6, I4).
 *
 * Each time somebody accepts an item of a batch, what they filed is compared
 * with what its card started from, field by field: its kind, whose it is,
 * its dates, its number and who issued it. A field changed, or filled where
 * nothing was proposed, is a correction. Corrections teach small rules,
 * never the text: **this issuer → this kind**, and **this issuer → this
 * person**. A rule keeps only the issuer's key (`issuerKey`: lower case,
 * accents, punctuation and the legal form gone), the kind's key or the
 * member's id, how many times it was confirmed and contradicted, and the day
 * it was last used. Never a number, a date, a name as typed, a file's name
 * or a word of the pages.
 *
 * Rules are each person's own (the lead's decision on privacy): learned only
 * from their own accepts, used only for their own items, read only by them —
 * not by another adult, not by an owner. "Letters from this clinic are
 * Sara's", learned from Sara's Only me documents, never proposes anything
 * on anybody else's uploads. The database holds them to that (0065).
 *
 * - **Learning.** For the issuer filed (or, where none was sent, the one the
 *   pages named), and each of the kind and the person filed: a correction
 *   makes the rule that says what was filed, or confirms it; an accept that
 *   changed nothing confirms the rule that says it, where there is one, and
 *   makes none. Every other rule of that issuer and field is contradicted.
 *   A rule contradicted more often than confirmed is dropped. A teen's
 *   documents are their own, so a teen is taught no person. At most
 *   LEARNED_RULES_MAX rules a person: past it, the least used go.
 * - **Using.** When the worker reads an item, and the pages name an issuer
 *   with a rule (`applyLearned`), the rule may propose the kind or the
 *   person where the pages proposed none, make surer a proposal it agrees
 *   with, and choose between kinds the pages could not tell apart (`tie`).
 *   It never replaces a proposal of the pages' that disagrees: a sure rule
 *   that disagrees is said beside it (`LearnedClash`), and the item is
 *   Check. Its proposals carry the cue `learned` ("learned from your
 *   earlier choices"), and are levelled by `levelItem` as any other:
 *   - **sure** (LEARNED_SURE_CONFIDENCE, over ITEM_SURE) only once the rule
 *     has been confirmed LEARNED_SURE_CONFIRMATIONS times and never
 *     contradicted;
 *   - otherwise LEARNED_CONFIDENCE: shown, and unsure, so the item is
 *     Check.
 *   Who can see it is never widened: a kind or a person proposed goes
 *   through the same narrowing as the pages' (`batchVisibility`), which a
 *   kind or a person can only narrow.
 * - **The count.** "Of your last 50 accepted, 31 needed no change": of the
 *   last LEARNING_WINDOW items read and accepted, how many had every field
 *   accepted as proposed (`correctionsOf` found none).
 */

/** Confirmed this many times, and never contradicted, and a rule's proposal is sure. */
export const LEARNED_SURE_CONFIRMATIONS = 3;
/** A sure rule's proposal: over ITEM_SURE, so it alone can make an item Ready. */
export const LEARNED_SURE_CONFIDENCE = 0.9;
/**
 * A rule not sure yet: at a proposal's threshold (PROPOSAL_THRESHOLDS), under
 * ITEM_SURE and CLASH_CONFIDENCE — shown, unsure, never a clash with a default.
 */
export const LEARNED_CONFIDENCE = 0.78;
/** A rule not sure yet raises an agreeing proposal by this much… */
export const LEARNED_RAISE = 0.05;
/** …and never to ITEM_SURE: only a sure rule makes a proposal sure. */
export const LEARNED_RAISE_UNSURE_MAX = 0.84;
/** The most rules one person keeps: past it, the least used go. */
export const LEARNED_RULES_MAX = 500;
/** The count is of this many accepted items, the newest. */
export const LEARNING_WINDOW = 50;
/** Accepts remembered for the count (and for an Undo to take back): more than the window. */
export const LEARNING_OUTCOMES_KEPT = 200;
/** The longest issuer key kept: a name as long as a title is not an issuer. */
export const LEARNED_ISSUER_MAX = 120;

/** What a rule says of an issuer: its kind, or whose it is. */
export type LearnedField = 'type_key' | 'owner_member_id';

/** One rule, as the worker uses it: nothing but the key, what it says, and its counts. */
export interface LearnedRule {
  issuer_key: string;
  field: LearnedField;
  /** A kind's key, or a member's id. */
  value: string;
  confirmed: number;
  contradicted: number;
}

/** What the worker reads an item's words with: its uploader's rules, and who they are. */
export interface LearnedContext {
  rules: readonly LearnedRule[];
  role: Role;
  /** The uploader's member. */
  me: string;
}

/**
 * Where a sure rule disagrees with what the pages propose (the pages' stands):
 * what the rule says, by field. The item is Check, with both said.
 */
export interface LearnedClash {
  type_key?: string;
  owner_member_id?: string;
}

/** `GET /api/v1/batches/learned`: one rule, as its person is shown it. */
export interface LearnedRuleView {
  id: string;
  /** The issuer's key, as the vault keeps it: lower case, its legal form gone. */
  issuer: string;
  field: LearnedField;
  /** A kind's key, or a member's id. */
  value: string;
  /** The kind's name, or the person's; null for one no longer there. */
  label: string | null;
  confirmed: number;
  contradicted: number;
  /** Confirmed LEARNED_SURE_CONFIRMATIONS times and never contradicted. */
  sure: boolean;
  /** The day it was last made or confirmed (YYYY-MM-DD). */
  last_used: string;
}

/** `GET /api/v1/batches/learned`: the count, and what was learned — the caller's own. */
export interface BatchLearning {
  /** Of the last `window` items read and accepted, how many there were (up to `window`). */
  counted: number;
  /** And how many of those needed no change. */
  unchanged: number;
  window: number;
  rules: LearnedRuleView[];
  rules_max: number;
}

/** Whether a rule's own counts are enough: confirmed enough, and never contradicted. */
export const ruleSure = (r: Pick<LearnedRule, 'confirmed' | 'contradicted'>): boolean =>
  r.confirmed >= LEARNED_SURE_CONFIRMATIONS && r.contradicted === 0;

/**
 * Whether a rule is trusted — its proposal sure (the I4 review, I4-1): its
 * own counts are enough (`ruleSure`), and no other rule of its issuer and
 * field says anything else that was ever confirmed. A shared surgery's
 * letters filed for Sara four times and then for Ahmed four times leave
 * Ahmed's rule never contradicted, but Sara's is still there: neither is
 * trusted, and "never chosen differently" stays true.
 */
export function ruleTrusted(
  rule: Pick<LearnedRule, 'issuer_key' | 'field' | 'value' | 'confirmed' | 'contradicted'>,
  rules: ReadonlyArray<Pick<LearnedRule, 'issuer_key' | 'field' | 'value' | 'confirmed'>>,
): boolean {
  return (
    ruleSure(rule) &&
    !rules.some(
      (r) =>
        r.issuer_key === rule.issuer_key &&
        r.field === rule.field &&
        r.value !== rule.value &&
        r.confirmed > 0,
    )
  );
}

/** A proposal that came from (or was made surer by) the uploader's earlier choices. */
export const isLearned = (p: Pick<Proposed<unknown>, 'cue' | 'learned'>): boolean =>
  p.cue === 'learned' || p.learned === true;

/** The issuer's key a rule is kept under: empty (no rule) when nothing useful is left. */
export function learnedIssuerKey(name: string | null | undefined): string {
  if (!name) return '';
  const key = issuerKey(name.slice(0, 200));
  return key.length > LEARNED_ISSUER_MAX ? '' : key;
}

/**
 * The one rule of an issuer and field that may be used: the most confirmed
 * net of its contradictions, and strictly ahead of the next — two rules as
 * good as each other say nothing. Only rules for a value that may be
 * proposed (`usable`).
 */
export function bestRule(
  rules: readonly LearnedRule[],
  key: string,
  field: LearnedField,
  usable: (value: string) => boolean,
): LearnedRule | null {
  const net = (r: LearnedRule) => r.confirmed - r.contradicted;
  const mine = rules
    .filter((r) => r.issuer_key === key && r.field === field && usable(r.value) && net(r) > 0)
    .sort((a, b) => net(b) - net(a) || b.confirmed - a.confirmed);
  const [best, next] = mine;
  if (!best) return null;
  if (next && net(next) === net(best)) return null;
  return best;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * What the pages proposed, with the uploader's rules for the issuer they
 * name (see above). Pure: the worker runs it on its proposal thread, beside
 * `proposeDetails`. `learnedKind` is a kind the rules proposed, for which
 * the pages' dates and number may now be read (`proposeLearned`).
 */
export function applyLearned(input: {
  proposal: DetailProposal;
  /** The kinds the pages could not choose between (`proposeWithTie`). */
  tie: readonly string[];
  learned: LearnedContext;
  types: readonly ProposalKind[];
  people: ReadonlyArray<{ id: string }>;
}): { proposal: DetailProposal; clash: LearnedClash; learnedKind: string | null } {
  const { learned } = input;
  const out: DetailProposal = { ...input.proposal };
  const clash: LearnedClash = {};
  const key = learnedIssuerKey(out.issued_by?.value);
  if (!key || learned.rules.length === 0) return { proposal: out, clash, learnedKind: null };

  const raise = (p: Proposed<string>, sure: boolean): Proposed<string> => {
    const to = sure
      ? Math.max(p.confidence, LEARNED_SURE_CONFIDENCE)
      : Math.max(
          p.confidence,
          Math.min(LEARNED_RAISE_UNSURE_MAX, round(p.confidence + LEARNED_RAISE)),
        );
    // The page's own confidence kept beside it: a clash with the batch, and
    // what "the pages say", are the page's alone (the I4 review, I4-4).
    return to > p.confidence
      ? { ...p, confidence: to, learned: true, page_confidence: p.confidence }
      : p;
  };

  // The kind: one the household keeps and may be proposed (never a hidden one).
  let learnedKind: string | null = null;
  const kindRule = bestRule(learned.rules, key, 'type_key', (v) =>
    input.types.some((t) => t.key === v && !t.hidden),
  );
  if (kindRule) {
    const sure = ruleTrusted(kindRule, learned.rules);
    const page = out.type_key;
    if (!page) {
      // Where the pages could not choose, a rule for one of their kinds
      // chooses; a rule for none of them is never sure.
      const fits = input.tie.length === 0 || input.tie.includes(kindRule.value);
      out.type_key = {
        value: kindRule.value,
        confidence: sure && fits ? LEARNED_SURE_CONFIDENCE : LEARNED_CONFIDENCE,
        cue: 'learned',
      };
      learnedKind = kindRule.value;
    } else if (page.value === kindRule.value) {
      out.type_key = raise(page, sure);
    } else if (sure) {
      clash.type_key = kindRule.value;
    }
  }

  // Whose it is: somebody of the family — and never for a teen, whose
  // documents are their own.
  if (learned.role !== 'teen') {
    const personRule = bestRule(learned.rules, key, 'owner_member_id', (v) =>
      input.people.some((m) => m.id === v),
    );
    if (personRule) {
      const sure = ruleTrusted(personRule, learned.rules);
      const page = out.owner_member_id;
      if (!page) {
        out.owner_member_id = {
          value: personRule.value,
          confidence: sure ? LEARNED_SURE_CONFIDENCE : LEARNED_CONFIDENCE,
          cue: 'learned',
        };
      } else if (page.value === personRule.value) {
        out.owner_member_id = raise(page, sure);
      } else if (sure) {
        clash.owner_member_id = personRule.value;
      }
    }
  }
  return { proposal: out, clash, learnedKind };
}

/**
 * What an item's words propose, with its uploader's rules (I4): the pages'
 * proposal (`proposeWithTie`), the rules applied (`applyLearned`), and — for
 * a kind only the rules proposed — the dates and number the pages give for
 * that kind, read as they are for a kind a document already has. Run on the
 * worker's proposal thread, as `proposeDetails` is.
 */
export function proposeLearned(
  text: string,
  ctx: ProposalContext,
  learned: LearnedContext | null | undefined,
): { proposal: DetailProposal; clash: LearnedClash } {
  const first = proposeWithTie(text, ctx);
  if (!learned || learned.rules.length === 0) return { proposal: first.proposal, clash: {} };
  const applied = applyLearned({
    proposal: first.proposal,
    tie: first.tie,
    learned,
    types: ctx.types,
    people: ctx.people,
  });
  if (applied.learnedKind) {
    const again = proposeDetails(text, {
      ...ctx,
      current: { ...ctx.current, type_key: applied.learnedKind },
    });
    for (const f of ['issued', 'expires', 'identifier'] as const) {
      const p = again[f];
      if (p && p.confidence >= PROPOSAL_THRESHOLDS[f]) {
        (applied.proposal as Record<string, unknown>)[f] = p;
      }
    }
  }
  return { proposal: applied.proposal, clash: applied.clash };
}

/** What was filed, as `correctionsOf` compares it. */
export type FiledDetails = Pick<
  CaptureMetadata,
  'type_key' | 'owner_member_id' | 'issued' | 'expires' | 'identifier' | 'issued_by'
>;

const sameDate = (a: DateValue | null, b: DateValue | null) =>
  a === null || b === null ? a === b : a.date === b.date && a.precision === b.precision;
const text = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/**
 * The fields an accept corrected (I4): each of the kind, whose it is, the
 * dates, the number and the issuer that was filed differently from what the
 * card started from (`proposals`: the pages', the rules' or the batch's),
 * or filled where nothing was proposed. A field the filed kind does not show
 * (an expiry for a kind that does not expire) is not filed, so not
 * corrected. None: it needed no change.
 */
export function correctionsOf(opts: {
  proposals: ItemProposals | null;
  filed: FiledDetails;
  /** The kind filed, as the household keeps it (only its fixed fields, and whether it expires); null for none. */
  kind: {
    core?: Partial<Record<CoreField, Partial<CoreFieldRule>>> | null;
    expiry_driver: DocumentTypeView['expiry_driver'];
  } | null;
}): ProposalField[] {
  const p = opts.proposals;
  const f = opts.filed;
  const shown = (key: 'issued' | 'identifier' | 'issued_by') =>
    opts.kind?.core?.[key]?.shown !== false;
  const out: ProposalField[] = [];
  if (text(f.type_key) !== (p?.type_key?.value ?? null)) out.push('type_key');
  if (text(f.owner_member_id) !== (p?.owner_member_id?.value ?? null)) {
    out.push('owner_member_id');
  }
  if (shown('issued') && !sameDate(f.issued ?? null, p?.issued?.value ?? null)) {
    out.push('issued');
  }
  if (opts.kind?.expiry_driver && !sameDate(f.expires ?? null, p?.expires?.value ?? null)) {
    out.push('expires');
  }
  if (shown('identifier') && text(f.identifier) !== text(p?.identifier?.value)) {
    out.push('identifier');
  }
  if (shown('issued_by') && text(f.issued_by) !== text(p?.issued_by?.value)) {
    out.push('issued_by');
  }
  return out;
}

/** One step of what an accept teaches: for an issuer, a field and the value filed. */
export interface LearningStep {
  field: LearnedField;
  value: string;
  /** Changed or filled on the card: the rule is made if it is not there. */
  corrected: boolean;
}

/**
 * What an accept teaches (I4): the issuer's key — the issuer filed, and only
 * that: one the pages named but the card did not file (a kind that hides
 * the field, or one cleared) teaches nothing, so what was read off the
 * pages never reaches a rule (the I4 review, I4-8) — and, for each of the
 * kind and the person filed, the value and whether it was a correction. A
 * teen is taught no person. Nothing without an issuer filed.
 */
export function learningOf(opts: {
  proposals: ItemProposals | null;
  filed: FiledDetails;
  role: Role;
}): { issuer: string; steps: LearningStep[] } {
  const { proposals: p, filed } = opts;
  const issuer = learnedIssuerKey(text(filed.issued_by));
  if (!issuer) return { issuer: '', steps: [] };
  const steps: LearningStep[] = [];
  for (const field of ['type_key', 'owner_member_id'] as const) {
    if (field === 'owner_member_id' && opts.role === 'teen') continue;
    const value = text(filed[field]);
    if (!value) continue;
    steps.push({ field, value, corrected: value !== (p?.[field]?.value ?? null) });
  }
  return { issuer, steps };
}

/** A rule as a store keeps it: with its id and the day it was last made or confirmed. */
export interface KeptRule extends LearnedRule {
  id: string;
  /** YYYY-MM-DD. */
  last_used: string;
}

/**
 * What an accept teaches, applied to one person's rules in memory — as the
 * API applies it in its database (apps/api learning.ts), for the client's
 * fake vault and the accuracy tests: the rule that says what was filed made
 * (a correction) or confirmed; every other rule of the issuer and field
 * contradicted; those contradicted more often than confirmed dropped; past
 * LEARNED_RULES_MAX, the least used. Answers the rules after, which it
 * confirmed and contradicted, and those it removed as they were (for an
 * Undo to put back, I4-3).
 */
export function teach(
  rules: readonly KeptRule[],
  lesson: { issuer: string; steps: readonly LearningStep[] },
  opts: { newId: () => string; today: string },
): { rules: KeptRule[]; confirmed: string[]; contradicted: string[]; removed: KeptRule[] } {
  let out = rules.map((r) => ({ ...r }));
  const confirmed: string[] = [];
  const contradicted: string[] = [];
  const made: string[] = [];
  const removed: KeptRule[] = [];
  if (!lesson.issuer) return { rules: out, confirmed, contradicted, removed };
  for (const step of lesson.steps) {
    const same = (r: KeptRule) => r.issuer_key === lesson.issuer && r.field === step.field;
    const own = out.find((r) => same(r) && r.value === step.value);
    if (own) {
      own.confirmed += 1;
      own.last_used = opts.today;
      confirmed.push(own.id);
    } else if (step.corrected) {
      const id = opts.newId();
      out.push({
        id,
        issuer_key: lesson.issuer,
        field: step.field,
        value: step.value,
        confirmed: 1,
        contradicted: 0,
        last_used: opts.today,
      });
      confirmed.push(id);
      made.push(id);
    }
    for (const r of out) {
      if (same(r) && r.value !== step.value) {
        r.contradicted += 1;
        contradicted.push(r.id);
      }
    }
  }
  removed.push(
    ...out.filter((r) => r.issuer_key === lesson.issuer && r.contradicted > r.confirmed),
  );
  out = out.filter((r) => r.issuer_key !== lesson.issuer || r.contradicted <= r.confirmed);
  const over = out.length - LEARNED_RULES_MAX;
  if (over > 0) {
    const gone = new Set(
      out
        .filter((r) => !made.includes(r.id))
        .sort(
          (a, b) =>
            a.last_used.localeCompare(b.last_used) ||
            a.confirmed - a.contradicted - (b.confirmed - b.contradicted) ||
            a.confirmed - b.confirmed ||
            a.id.localeCompare(b.id),
        )
        .slice(0, over)
        .map((r) => r.id),
    );
    removed.push(...out.filter((r) => gone.has(r.id)));
    out = out.filter((r) => !gone.has(r.id));
  }
  return { rules: out, confirmed, contradicted, removed };
}
