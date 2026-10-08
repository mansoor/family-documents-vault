import {
  batchVisibility,
  duplicateWords,
  type BatchDefaults,
  type BatchDuplicate,
  type BatchItemState,
  type BatchReadState,
} from './batches.js';
import {
  missingFields,
  type DateValue,
  type DocumentTypeView,
  type Visibility,
} from './documents.js';
import {
  PROPOSAL_CUES,
  type DetailProposal,
  type ProposalCue,
  type Proposed,
} from './proposals.js';
import { seesLocation, type Role } from './roles.js';

/**
 * What the vault made of a batch's item once it read its pages (Phase 6,
 * I2): a level, the tags that say why, and what its card starts from.
 *
 * Worked out as it is asked, for its uploader alone, from three things: what
 * the pages proposed (`proposeDetails`, sealed under the item's key when the
 * worker read it), the batch's defaults as they are now, and the kinds as
 * the household keeps them now. So a default changed, or a kind's required
 * fields, re-levels every item without its pages being read again.
 *
 * - **Defaults fill only blanks** (the owner's decision Q4). Where the pages
 *   propose something else at `CLASH_CONFIDENCE` or more, the default
 *   stands on the card and the item goes to Check with both values: "The
 *   pages say Sara, the batch says Ahmed". A weaker disagreement keeps the
 *   default, silently.
 * - **Ready**: the kind and whose it is are sure (`ITEM_SURE`) — or given by
 *   a default no confident proposal disagrees with — and every detail the
 *   kind requires is filled.
 * - **Check**: something is unsure, missing or disagreed about; its tags
 *   say what.
 * - **Not recognised**: no kind proposed, and none chosen for the batch.
 * - **Problem**: the pages could not be read, or it is a duplicate.
 * - Not read yet: no level (`null`); `reading` says where it is.
 *
 * Who can see it is never widened by a guess: the batch's choice stands,
 * and a kind usually kept narrower (Adults only, Only me) narrows it, said
 * by a tag (`batchVisibility`).
 */

/** How an item stands once read. */
export type BatchLevel = 'ready' | 'check' | 'unrecognised' | 'problem';

/** Each level in words, as the batch page and its summary say it. */
export const LEVEL_WORDS: Readonly<Record<BatchLevel, string>> = {
  ready: 'Ready',
  check: 'Check',
  unrecognised: 'Not recognised',
  problem: 'Problem',
};

/**
 * Why an item's pages were not read:
 *  - `blank`: no words on them (an empty sheet, the back of one);
 *  - `password`: a PDF that needs a password, which the vault never asks for;
 *  - `unreadable`: the file could not be read as what it is;
 *  - `too_slow`: proposing from them took longer than its deadline;
 *  - `not_read`: a kind of file the vault does not read (a spreadsheet).
 */
export type BatchReadFailure = 'blank' | 'password' | 'unreadable' | 'too_slow' | 'not_read';

export const READ_FAILURES: readonly BatchReadFailure[] = [
  'blank',
  'password',
  'unreadable',
  'too_slow',
  'not_read',
];

/** Each reason in words, under "Couldn't read the pages". */
export const READ_FAILURE_WORDS: Readonly<Record<BatchReadFailure, string>> = {
  blank: 'The pages look blank: the scanner may have fed an empty sheet, or the back of one.',
  password:
    'The PDF has a password, and the vault never asks for it. Save a copy without the password and add that instead.',
  unreadable: 'The file could not be read as what it says it is.',
  too_slow: 'Reading its pages took too long, so nothing is suggested.',
  not_read: 'The vault does not read this kind of file: fill in its details yourself.',
};

/** What a tag says, for code to tell apart; its words are for people. */
export type BatchTagCode =
  | 'duplicate_document'
  | 'duplicate_in_batch'
  | 'duplicate_item'
  | 'unread'
  | 'not_read'
  | 'clash_kind'
  | 'clash_person'
  | 'kind_unsure'
  | 'person_unsure'
  | 'expiry_unsure'
  | 'missing'
  | 'person_missing'
  | 'narrowed';

/** One reason for an item's level: a Problem's, a Check's, or something worth knowing. */
export interface BatchTag {
  code: BatchTagCode;
  /** What it makes the level: `problem`, `check`, or nothing (`info`). */
  kind: 'problem' | 'check' | 'info';
  /** The tag as shown: "Person unsure", "Missing: expiry (required for a passport)". */
  words: string;
  /** More, where there is more to say: why the pages could not be read. */
  detail?: string;
  /** The field it is about, for `missing`: a fixed field ('expires') or one of the kind's own. */
  field?: string;
}

/**
 * One detail the card starts from: read from the pages (with how sure, and
 * why), chosen for the batch, or both saying the same.
 */
export interface ItemSuggestion<T> {
  value: T;
  from: 'pages' | 'batch' | 'both';
  /** How sure the pages are, for `pages` and `both`; null for the batch's alone. */
  confidence: number | null;
  cue: ProposalCue | null;
}

/** Who can see it, as the card starts: the batch's choice, as its kind usually is, or narrowed. */
export interface ItemVisibility {
  value: Visibility;
  from: 'batch' | 'kind' | 'narrowed';
}

/** What the card starts from, after the defaults are merged in. */
export interface ItemProposals {
  type_key?: ItemSuggestion<string>;
  owner_member_id?: ItemSuggestion<string>;
  issued?: ItemSuggestion<DateValue>;
  expires?: ItemSuggestion<DateValue>;
  identifier?: ItemSuggestion<string>;
  issued_by?: ItemSuggestion<string>;
  visibility: ItemVisibility;
}

/** Where the pages and a default confidently disagree: the default stands until somebody chooses. */
export interface BatchClash {
  field: 'type_key' | 'owner_member_id';
  pages: { value: string; confidence: number; cue: ProposalCue };
  batch: string;
}

/**
 * At or above these, a proposal is sure: under, it is shown with its tag
 * ("Kind unsure"). Every proposal is at or above its field's threshold
 * already (PROPOSAL_THRESHOLDS); these are the bar for not looking twice.
 */
export const ITEM_SURE = { type_key: 0.85, owner_member_id: 0.85, expires: 0.8 } as const;

/** A proposal this sure that differs from a default is a clash (the prototype's bar). */
export const CLASH_CONFIDENCE = 0.8;

/** A kind as levelling needs it: GET /document-types' view, or enough of it. */
export type LevelKind = Pick<
  DocumentTypeView,
  'key' | 'label' | 'default_visibility' | 'expiry_driver' | 'fields'
> &
  Partial<Pick<DocumentTypeView, 'core'>>;

export interface LevelInput {
  state: BatchItemState;
  reading: BatchReadState;
  failure: BatchReadFailure | null;
  /** What the pages proposed, once read; null before, or when nothing could be. */
  proposal: DetailProposal | null;
  duplicate: BatchDuplicate | null;
  defaults: BatchDefaults;
  /** The household's kinds as they are now, and not deleted. */
  types: readonly LevelKind[];
  /** The family the uploader may choose from, by the name the household knows them by. */
  people: ReadonlyArray<{ id: string; name: string }>;
  role: Role;
  /** The uploader's member. */
  me: string;
  /** How a batch with no name is called in a duplicate's words. */
  batchLabel?: (b: { name: string | null; created_at: string }) => string;
}

export interface ItemLevel {
  /** Null while it is not read yet (and is no duplicate), and once it is accepted. */
  level: BatchLevel | null;
  tags: BatchTag[];
  /** What the card starts from; null once it is accepted. */
  proposals: ItemProposals | null;
  clashes: BatchClash[];
}

const NARROW: Record<Visibility, number> = { private: 0, adults: 1, household: 2 };

/** The words for a missing fixed field, mid-sentence, where the kind gives none of its own. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  identifier: 'number',
  issued_by: 'who issued it',
  issued: 'issue date',
  expires: 'expiry',
  physical_location: 'where the paper copy is',
  tags: 'tags',
  notes: 'notes',
};

const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
/** "a passport", "an insurance policy". */
const aKind = (label: string) => {
  const l = lowerFirst(label);
  return `${/^[aeiou]/.test(l) ? 'an' : 'a'} ${l}`;
};

/**
 * An item's level, tags, clashes and what its card starts from: the pages'
 * proposals merged with the batch's defaults and the kinds as they are now.
 * Pure: the API works it out for the uploader as it answers, and the fake
 * vault the same way.
 */
export function levelItem(input: LevelInput): ItemLevel {
  if (input.state === 'accepted') return { level: null, tags: [], proposals: null, clashes: [] };
  const { defaults: d, types, people, role, me } = input;
  const tags: BatchTag[] = [];
  const clashes: BatchClash[] = [];
  let problem = false;

  if (input.duplicate) {
    const dup = input.duplicate;
    tags.push({
      code:
        dup.of === 'document'
          ? 'duplicate_document'
          : dup.same_batch
            ? 'duplicate_in_batch'
            : 'duplicate_item',
      kind: 'problem',
      words: duplicateWords(dup, input.batchLabel),
    });
    problem = true;
  }
  const read = input.reading === 'read';
  if (input.reading === 'failed') {
    const why = input.failure ?? 'unreadable';
    if (why === 'not_read') {
      tags.push({
        code: 'not_read',
        kind: 'info',
        words: 'Not read',
        detail: READ_FAILURE_WORDS[why],
      });
    } else {
      tags.push({
        code: 'unread',
        kind: 'problem',
        words: 'Couldn’t read the pages',
        detail: READ_FAILURE_WORDS[why],
      });
      problem = true;
    }
  }

  const pages: DetailProposal = read && input.proposal ? input.proposal : {};
  const kindOf = (key: string | null | undefined) =>
    key ? (types.find((t) => t.key === key) ?? null) : null;
  // A teen's documents are their own: whose it is, is them.
  const choosable = (id: string) =>
    people.some((p) => p.id === id) && (role !== 'teen' || id === me);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'somebody';

  // A proposal for a kind since deleted, or a person no longer to be chosen, is none.
  const kindP = pages.type_key && kindOf(pages.type_key.value) ? pages.type_key : undefined;
  const personP =
    pages.owner_member_id && choosable(pages.owner_member_id.value)
      ? pages.owner_member_id
      : undefined;
  const kindD = kindOf(d.type_key)?.key ?? null;
  const personD =
    role === 'teen'
      ? me
      : d.owner_member_id && people.some((p) => p.id === d.owner_member_id)
        ? d.owner_member_id
        : null;

  /** A field with a default and a proposal: the default fills only a blank (Q4). */
  const merge = (
    field: 'type_key' | 'owner_member_id',
    p: Proposed<string> | undefined,
    dflt: string | null,
  ): ItemSuggestion<string> | undefined => {
    if (p && dflt === null)
      return { value: p.value, from: 'pages', confidence: p.confidence, cue: p.cue };
    if (dflt === null) return undefined;
    if (!p) return { value: dflt, from: 'batch', confidence: null, cue: null };
    if (p.value === dflt)
      return { value: dflt, from: 'both', confidence: p.confidence, cue: p.cue };
    if (p.confidence >= CLASH_CONFIDENCE) {
      clashes.push({
        field,
        pages: { value: p.value, confidence: p.confidence, cue: p.cue },
        batch: dflt,
      });
    }
    return { value: dflt, from: 'batch', confidence: null, cue: null };
  };

  const proposals: Omit<ItemProposals, 'visibility'> = {};
  const kindS = merge('type_key', kindP, kindD);
  const personS = merge('owner_member_id', personP, personD);
  if (kindS) proposals.type_key = kindS;
  if (personS) proposals.owner_member_id = personS;
  const kind = kindOf(kindS?.value);

  // Its dates and its number were read for the kind the pages proposed: for
  // another kind (the batch's), they are not offered — nor its issuer.
  const forKind = !kindP || kindP.value === kindS?.value;
  if (forKind) {
    for (const field of ['issued', 'expires', 'identifier', 'issued_by'] as const) {
      const p = pages[field];
      if (!p) continue;
      (proposals as Record<string, ItemSuggestion<unknown>>)[field] = {
        value: p.value,
        from: 'pages',
        confidence: p.confidence,
        cue: p.cue,
      };
    }
  }

  // Who can see it: never wider than the batch chose, narrowed by the kind.
  const owner = personS?.value ?? (role === 'teen' ? me : null);
  const vis = batchVisibility({ chosen: d.visibility, type: kind, role, owner, me });
  const visibility: ItemVisibility =
    d.visibility === null
      ? { value: vis, from: 'kind' }
      : NARROW[vis] < NARROW[d.visibility]
        ? { value: vis, from: 'narrowed' }
        : { value: vis, from: 'batch' };

  for (const c of clashes) {
    if (c.field === 'owner_member_id') {
      tags.push({
        code: 'clash_person',
        kind: 'check',
        words: `The pages say ${nameOf(c.pages.value)}, the batch says ${nameOf(c.batch)}`,
      });
    } else {
      tags.push({
        code: 'clash_kind',
        kind: 'check',
        words: `The pages say ${aKind(kindOf(c.pages.value)?.label ?? 'kind')}, the batch says ${aKind(kindOf(c.batch)?.label ?? 'kind')}`,
      });
    }
  }
  if (kind) {
    if (kindS?.from === 'pages' && (kindS.confidence ?? 0) < ITEM_SURE.type_key) {
      tags.push({ code: 'kind_unsure', kind: 'check', words: 'Kind unsure' });
    }
    if (!personS) {
      tags.push({ code: 'person_missing', kind: 'check', words: 'Missing: whose it is' });
    } else if (personS.from === 'pages' && (personS.confidence ?? 0) < ITEM_SURE.owner_member_id) {
      tags.push({ code: 'person_unsure', kind: 'check', words: 'Person unsure' });
    }
    const missing = missingFields(kind, {
      issued: proposals.issued?.value ?? null,
      expires: proposals.expires?.value ?? null,
      identifier: proposals.identifier?.value ?? null,
      issued_by: proposals.issued_by?.value ?? null,
      // Where the paper copies are, for whoever sees that (seesLocation).
      physical_location: seesLocation(role) ? d.physical_location : null,
      tags: d.tags,
      notes: null,
      extra: {},
    });
    for (const m of missing) {
      const word = m.label ? lowerFirst(m.label) : (FIELD_WORDS[m.key] ?? lowerFirst(m.key));
      tags.push({
        code: 'missing',
        kind: 'check',
        field: m.key,
        words: `Missing: ${word} (required for ${aKind(kind.label)})`,
      });
    }
    const expires = proposals.expires;
    if (
      expires?.from === 'pages' &&
      (expires.confidence ?? 0) < ITEM_SURE.expires &&
      !missing.some((m) => m.key === 'expires')
    ) {
      tags.push({ code: 'expiry_unsure', kind: 'check', words: 'Expiry unsure' });
    }
    if (visibility.from === 'narrowed') {
      const to = visibility.value === 'private' ? 'Only me' : 'adults';
      tags.push({
        code: 'narrowed',
        kind: 'info',
        words:
          kindS?.from === 'batch'
            ? `Kept to ${to}: as ${aKind(kind.label)} usually is`
            : `Kept to ${to}: it looks like ${aKind(kind.label)}`,
      });
    }
  }

  let level: BatchLevel | null;
  if (problem) level = 'problem';
  else if (!read && input.reading !== 'failed') level = null;
  else if (!kind) level = 'unrecognised';
  else if (tags.some((t) => t.kind === 'check')) level = 'check';
  else level = 'ready';
  return { level, tags, proposals: { ...proposals, visibility }, clashes };
}

/** "12 Ready, 5 Check, 2 Not recognised, 1 Problem": the levels there are, in order. */
export function levelSummary(counts: Partial<Record<BatchLevel, number>>): string {
  const parts: string[] = [];
  for (const level of ['ready', 'check', 'unrecognised', 'problem'] as const) {
    const n = counts[level] ?? 0;
    if (n === 0) continue;
    parts.push(`${n} ${level === 'problem' && n !== 1 ? 'Problems' : LEVEL_WORDS[level]}`);
  }
  return parts.join(', ');
}

/**
 * What the worker sealed, opened: `{ v: 1, proposal }`, each field kept only
 * if it is well formed — a value of the right kind, a confidence from 0 to 1
 * and a cue the vault knows. Anything else is nothing proposed.
 */
export function storedProposal(raw: unknown): DetailProposal {
  const out: DetailProposal = {};
  if (!raw || typeof raw !== 'object') return out;
  const p = (raw as { v?: unknown; proposal?: unknown }).proposal;
  if ((raw as { v?: unknown }).v !== 1 || !p || typeof p !== 'object') return out;
  const fieldOf = (v: unknown, date: boolean) => {
    if (!v || typeof v !== 'object') return null;
    const f = v as { value?: unknown; confidence?: unknown; cue?: unknown };
    if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) return null;
    if (typeof f.cue !== 'string' || !(PROPOSAL_CUES as readonly string[]).includes(f.cue)) {
      return null;
    }
    if (date) {
      const d = f.value as { date?: unknown; precision?: unknown } | null;
      if (
        !d ||
        typeof d.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
        !['day', 'month', 'year'].includes(String(d.precision))
      ) {
        return null;
      }
    } else if (typeof f.value !== 'string' || f.value.length > 500) {
      return null;
    }
    return f as never;
  };
  const src = p as Record<string, unknown>;
  for (const k of ['type_key', 'owner_member_id', 'identifier', 'issued_by'] as const) {
    const f = fieldOf(src[k], false);
    if (f) out[k] = f;
  }
  for (const k of ['issued', 'expires'] as const) {
    const f = fieldOf(src[k], true);
    if (f) out[k] = f;
  }
  return out;
}
