/**
 * What the vault's reading model may say about a page's kind (0.9.0, R2):
 * one more cue beside the rules, never the decider, and never what makes a
 * card Ready. Pure, and run on the worker's proposal thread with the rest of
 * a proposal (`proposeOnThread`), over the page's start: its first
 * READING_MODEL_START characters, a first page's worth (what is read of a
 * file has no page breaks to go by).
 *
 * - **Where the rules found no kind,** the model may suggest one it is at
 *   least READING_MODEL_SUGGEST sure of: offered at
 *   READING_MODEL_ALONE_CONFIDENCE, under the bar a Ready card needs and
 *   under the folder's (FOLDER_AGREE_FLOOR), so the card is Check however
 *   its folder reads; and its dates and number are read for that kind. Where
 *   the rules' cues tie between kinds, only one of those.
 * - **Where it agrees with the rules' own kind,** nothing changes. (Until the
 *   R2 review it could make a kind the rules held unsure sure. The rules hold
 *   a kind unsure for its score only where another kind scores 2 or more
 *   close behind it — and two papers in one file are just that: it made the
 *   second paper's kind Ready. Kept to kinds with no rival, it could never
 *   fire, so it is gone.)
 * - **Where it disagrees,** at least READING_MODEL_DOUBT sure of another
 *   kind (or, against the rules' cues, of none), the kind stands but is not
 *   sure: the card is Check, and says what the model read — whatever kind
 *   that is, one the rules rule out for the page included, since a doubt
 *   only ever lowers. Against the uploader's own rules (I4) or a sender's
 *   layout (R1), only another kind counts, and the same: Check, never their
 *   kind replaced. A kind the model does not know (a household's own) it
 *   neither doubts nor suggests.
 *
 * It suggests the vault's built-in kinds alone: never a household's own
 * kind, never a hidden one, never "Something else" or a note; and never a
 * kind the rules rule out for the page (`kindVetoed`: a contract is no
 * payslip). The thresholds were set on the tune split alone
 * (docs/smart-exit.md, "Reading model").
 */
import {
  kindVetoed,
  PROPOSAL_THRESHOLDS,
  proposeDetails,
  type DetailProposal,
  type ProposalContext,
  type Proposed,
} from './proposals.js';
import type { KindChance } from './reading-model.js';

/** As sure as this, the model may suggest a kind the rules found none for. */
export const READING_MODEL_SUGGEST = 0.7;
/** As sure as this of something else, the rules' kind is not sure. */
export const READING_MODEL_DOUBT = 0.9;
/** The page's start the model is asked about: a first page's worth. */
export const READING_MODEL_START = 3_000;
/** A kind the model suggested alone: shown, never sure (under ITEM_SURE and FOLDER_AGREE_FLOOR). */
export const READING_MODEL_ALONE_CONFIDENCE = 0.78;
/** The rules' kind, doubted: just under sure. */
export const READING_MODEL_DOUBT_CONFIDENCE = 0.84;
/** Never proposed by the model, whatever the household keeps. */
export const READING_MODEL_NEVER: ReadonlySet<string> = new Set(['none', 'other', 'note']);

/** What the rules made of the page, before anything learned (`proposeWithTie`). */
export interface RulesReading {
  tie: readonly string[];
}

const filled = (v: unknown) =>
  v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== '');
const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
const learnedOrShaped = (p: Proposed<unknown> | undefined) =>
  !!p && (p.cue === 'learned' || p.learned === true || p.shape === true);

/** Whether the model may propose a kind for this household: a built-in it keeps, shown. */
export function modelMayPropose(ctx: Pick<ProposalContext, 'types'>, key: string): boolean {
  if (READING_MODEL_NEVER.has(key)) return false;
  return ctx.types.some((t) => t.key === key && t.hidden !== true && t.builtin !== false);
}

/**
 * The proposal with the reading model's say: the rules' proposal (and
 * whatever the uploader's rules and layouts made of it) and the model's
 * chances for the page's start. With no chances — no model, or the
 * household's switch off — the proposal as it was.
 */
export function applyReadingModel(input: {
  text: string;
  ctx: ProposalContext;
  proposal: DetailProposal;
  rules: RulesReading;
  chances: readonly KindChance[] | null;
}): DetailProposal {
  const { text, ctx, proposal, rules, chances } = input;
  const top = chances?.[0];
  if (!top || ctx.readingModel === false) return proposal;
  // A kind the document has already: nothing to say.
  if (filled(ctx.current?.type_key)) return proposal;
  const out: DetailProposal = { ...proposal };
  const kind = out.type_key;
  const chanceOf = (k: string) => chances?.find((c) => c.kind === k)?.p ?? 0;

  if (!kind) {
    if (top.p < READING_MODEL_SUGGEST || !modelMayPropose(ctx, top.kind)) return out;
    // A kind the rules rule out for this page (a contract is no payslip).
    if (kindVetoed(top.kind, text)) return out;
    // Where the rules' cues tie between kinds, only one of those.
    if (rules.tie.length > 0 && !rules.tie.includes(top.kind)) return out;
    out.type_key = {
      value: top.kind,
      confidence: READING_MODEL_ALONE_CONFIDENCE,
      cue: 'kind_words',
      model: 'alone',
    };
    // Its dates, its number and who issued it (a passport's country), read
    // as for a kind the document has, held to the kind's own confidence as
    // the rules' are — never over a detail the uploader's rules or a
    // sender's layout gave (the R2 review).
    const factor = 0.6 + 0.4 * READING_MODEL_ALONE_CONFIDENCE;
    const again = proposeDetails(text, {
      ...ctx,
      current: { ...ctx.current, type_key: top.kind },
    });
    for (const f of ['issued', 'expires', 'identifier'] as const) {
      const p = again[f] as Proposed<unknown> | undefined;
      if (!p || out[f]) continue;
      const confidence = round(p.confidence * factor);
      if (confidence >= PROPOSAL_THRESHOLDS[f]) {
        (out as Record<string, unknown>)[f] = { ...p, confidence };
      }
    }
    const was = out.issued_by;
    if (again.issued_by && again.issued_by.value !== was?.value && !learnedOrShaped(was)) {
      const confidence = round(again.issued_by.confidence * factor);
      if (confidence >= PROPOSAL_THRESHOLDS.issued_by) {
        out.issued_by = { ...again.issued_by, confidence };
      }
    }
    return out;
  }

  // A passport's machine-readable lines, their check digits right, are not doubted.
  if (kind.cue === 'machine_lines') return out;
  // A kind the model does not know (a household's own): it has nothing to
  // say of it, for or against (the R2 review).
  if (!chances?.some((c) => c.kind === kind.value)) return out;
  if (top.kind === kind.value) return out;
  const doubt = (): DetailProposal => ({
    ...out,
    type_key: {
      ...kind,
      confidence: Math.min(kind.confidence, READING_MODEL_DOUBT_CONFIDENCE),
      model: 'doubts',
      model_kind: top.kind,
    },
  });
  const sure = top.p >= READING_MODEL_DOUBT && chanceOf(kind.value) < 1 - READING_MODEL_DOUBT;
  // The uploader's own rules (I4) or a sender's layout (R1): only another
  // kind, surely read, makes it unsure; it is never replaced.
  if (learnedOrShaped(kind)) return sure && top.kind !== 'none' ? doubt() : out;
  return sure ? doubt() : out;
}
