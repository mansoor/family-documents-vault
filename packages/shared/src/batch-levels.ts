import {
  batchVisibility,
  duplicateWords,
  renewalWords,
  type BatchDefaults,
  type BatchDuplicate,
  type BatchItemState,
  type BatchReadState,
} from './batches.js';
import {
  expiryOptional,
  missingFields,
  type DateValue,
  type DocumentTypeView,
  type Visibility,
} from './documents.js';
import {
  MAX_EXPIRY_LABEL_KINDS,
  PROPOSAL_CUES,
  type DetailProposal,
  type ProposalCue,
  type Proposed,
} from './proposals.js';
import { isLearned, type LearnedClash } from './learning.js';
import { shortTypeLabel } from './titles.js';
import {
  FOLDER_AGREE_FLOOR,
  FOLDER_AGREE_MAX,
  FOLDER_AGREE_RAISE,
  FOLDER_CONFIDENCE,
  type FolderSuggestion,
} from './folders.js';
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
 *
 * **The folder it came from** (0.8.0, S2, `suggestFromFolder`) is one more
 * source, below a sure page reading: alone, its kind or person is shown
 * from the folder, unsure (FOLDER_CONFIDENCE); agreeing with the pages, it
 * raises what the pages alone said by FOLDER_AGREE_RAISE — to a sure
 * reading only where they were FOLDER_AGREE_FLOOR sure already, otherwise
 * to just under ITEM_SURE (and the uploader's rules alone only where the
 * rule is sure: never an unsure rule made Ready); disagreeing, the pages'
 * stands and the item is Check, with both said ("The folder says
 * Passport; the pages look like a driver's licence"). A default the
 * uploader chose for the batch wins over the folder, silently: the folder
 * fills only what the defaults leave blank — tags too, which are only ever
 * offered or ticked on the card (`ItemTagSuggestion`), never filed by
 * Accept all Ready, and never counted for a kind's required tags.
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
 *  - `not_read`: a kind of file the vault does not read (a spreadsheet);
 *  - `not_reachable`: the vault could not get to it — its storage, a key,
 *    the proposal thread — for a day; not the file's fault.
 */
export type BatchReadFailure =
  | 'blank'
  | 'password'
  | 'unreadable'
  | 'too_slow'
  | 'not_read'
  /** The vault could not get to it — its storage, a key, the thread — for a day (the I2 check). */
  | 'not_reachable';

export const READ_FAILURES: readonly BatchReadFailure[] = [
  'blank',
  'password',
  'unreadable',
  'too_slow',
  'not_read',
  'not_reachable',
];

/** Each reason in words, under "Couldn't read the pages". */
export const READ_FAILURE_WORDS: Readonly<Record<BatchReadFailure, string>> = {
  blank: 'The pages look blank: the scanner may have fed an empty sheet, or the back of one.',
  password:
    'The PDF has a password, and the vault never asks for it. Save a copy without the password and add that instead.',
  unreadable: 'The file could not be read as what it says it is.',
  too_slow: 'Reading its pages took too long, so nothing is suggested.',
  not_read: 'The vault does not read this kind of file: fill in its details yourself.',
  not_reachable: 'The vault couldn’t read it in time. Remove it, or carry on uploading it again.',
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
  | 'narrowed'
  /** A teen's: the pages confidently name somebody else of the family (the I2 review). */
  | 'not_theirs'
  /** The pages and a sure rule of the uploader's own disagree (I4): the pages' stands. */
  | 'clash_learned'
  /**
   * Probably the same paper as a document of the uploader's, or its renewal
   * (0.8.0, S1): "New version of Aisha's passport?". Check, never Ready, so
   * Accept all Ready never files a renewal as a document of its own.
   */
  | 'renewal'
  /**
   * The folder it came from says another kind, or another person, than the
   * pages (or the uploader's rules) do (0.8.0, S2): the pages' stands.
   */
  | 'clash_folder'
  /** A date the pages gave only once OCR's confusions were put right ("2O26": 0.9.0, R3). */
  | 'date_corrected';

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
  /**
   * `learned` (I4): proposed, or made surer, by the uploader's own earlier
   * choices for the issuer the pages name — "learned from your earlier
   * choices". Absent from a vault before I4. `folder` (0.8.0, S2): from the
   * name of the folder it came from alone ("suggested from the folder
   * ‘Passports/Ahmed’"), with no cue. Absent from a vault before 0.8.0.
   */
  from: 'pages' | 'batch' | 'both' | 'learned' | 'folder';
  /**
   * How sure: the pages (or the rules) for `pages`, `learned` and `both`;
   * the folder's for `folder`; null for the batch's alone.
   */
  confidence: number | null;
  cue: ProposalCue | null;
  /**
   * The folder it came from says the same (0.8.0, S2): `confidence` is the
   * surer for it. Only beside `pages` or `learned`.
   */
  folder?: true;
  /**
   * Proposed, or made surer, by the uploader's earlier papers of this
   * sender's layout (0.9.0, R1): "learned from your earlier papers from
   * Northgate". Only beside `learned`. Absent from a vault before 0.9.0.
   */
  shape?: true;
  /**
   * Read from digits OCR's confusions were put right in ("2O26": 0.9.0,
   * R3): the card is Check for it. Absent from a vault before 0.9.0.
   */
  corrected?: true;
  /**
   * The vault's reading model suggested this kind where the rules found
   * none (0.9.0, R2) — "suggested by the vault's reading model", never sure.
   * Only beside `pages`, and only for a kind. Absent from a vault before 0.9.0.
   */
  model?: true;
}

/**
 * A tag the card starts with, or offers (0.8.0, S2): from the folder an
 * item came from, where the batch chose no tags. Accept all Ready, and an
 * untouched accept (`untouchedAccept`), never file one. The card ticks one
 * (`ticked`) only if it is already on a document the uploader can see that
 * is seen at least as widely as this item would be filed: a tag of their
 * Only me papers is never ticked onto one everybody sees. Any other —
 * used more narrowly, or new ("new tag from the folder name") — is only
 * offered, and made only if the item is accepted with it.
 */
export interface ItemTagSuggestion {
  value: string;
  from: 'folder';
  /** Already on a document the uploader can see. */
  existing: boolean;
  /** Ticked on the card as it starts: used, at least as widely as the item would be seen. */
  ticked: boolean;
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
  /** Tags from the folder it came from, where the batch chose none (0.8.0, S2). */
  tags?: ItemTagSuggestion[];
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
  Partial<Pick<DocumentTypeView, 'core' | 'short_label'>>;

export interface LevelInput {
  state: BatchItemState;
  reading: BatchReadState;
  failure: BatchReadFailure | null;
  /** What the pages proposed, once read; null before, or when nothing could be. */
  proposal: DetailProposal | null;
  /** Where a sure rule of the uploader's disagreed with the pages, as the worker read it (I4). */
  learnedClash?: LearnedClash | null;
  /**
   * The kinds complete without an expiry whose own expiry label is on the
   * pages (0.9.0, R3, the re-check: `expiryLabelKinds`, sealed beside the
   * proposal): a card of one of them with no expiry is Check, never Ready.
   */
  expiryLabels?: readonly string[];
  duplicate: BatchDuplicate | null;
  /** Its best near match, a document the uploader may change (0.8.0, S1): it makes the item Check. */
  renewal?: { title: string | null } | null;
  /**
   * What the folder it came from suggests (0.8.0, S2), worked out for the
   * uploader as it is asked (`suggestFromFolder`); null with no folder.
   */
  folder?: FolderSuggestion | null;
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
/** A kind by its short name ("Bank statement", "Bill"), as a line names it (`shortTypeLabel`). */
const shortName = (k: LevelKind | null | undefined) => (k ? shortTypeLabel(k) : undefined);

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

  // What the folder it came from says (S2): a kind the uploader is given, and
  // somebody they may choose — asked again here, as the pages' are.
  const folder = input.folder ?? null;
  const kindF = folder?.type_key && kindOf(folder.type_key) ? folder.type_key : null;
  const personF =
    folder?.owner_member_id && choosable(folder.owner_member_id) ? folder.owner_member_id : null;
  const folderClashes: Array<{
    field: 'type_key' | 'owner_member_id';
    folder: string;
    other: string;
    rules: boolean;
    /** The other is the reading model's alone (R2): the folder's stands. */
    model?: boolean;
  }> = [];

  /**
   * A field with a default, a proposal and the folder: the default fills
   * only a blank (Q4), and wins over the folder; the folder fills a blank
   * the default leaves, below a sure page reading, and makes an agreeing
   * proposal surer (S2).
   */
  const merge = (
    field: 'type_key' | 'owner_member_id',
    p: Proposed<string> | undefined,
    dflt: string | null,
    fromFolder: string | null,
  ): ItemSuggestion<string> | undefined => {
    // The uploader's earlier choices alone (I4): never "the pages say".
    const rulesOnly = p?.cue === 'learned';
    // How sure the pages alone were: a rule's raising never makes a clash,
    // nor speaks for the pages (the I4 review, I4-4).
    const own = p ? (p.page_confidence ?? p.confidence) : 0;
    if (p && dflt === null) {
      const said: ItemSuggestion<string> = {
        value: p.value,
        from: isLearned(p) ? 'learned' : 'pages',
        confidence: p.confidence,
        cue: p.cue,
        ...(p.shape ? { shape: true as const } : {}),
        // The reading model suggested it (R2).
        ...(field === 'type_key' && p.model === 'alone' ? { model: true as const } : {}),
      };
      if (fromFolder === null) return said;
      // The reading model's kind alone never stands over the folder's (R2):
      // the folder's is shown, and both are said.
      if (p.model === 'alone' && fromFolder !== p.value) {
        folderClashes.push({
          field,
          folder: fromFolder,
          other: p.value,
          rules: false,
          model: true,
        });
        return { value: fromFolder, from: 'folder', confidence: FOLDER_CONFIDENCE, cue: null };
      }
      if (fromFolder === p.value) {
        // Raised from what the pages alone said (a rule's raising aside, I4-4);
        // to a sure reading only where the pages alone were nearly sure — or,
        // for the rules alone, where the rule is sure already. Never a kind
        // the reading model suggested alone, or doubted (R2).
        const sure = ITEM_SURE[field];
        const raised = Math.round((own + FOLDER_AGREE_RAISE) * 100) / 100;
        const mayBeSure =
          p.model === 'alone' || p.model === 'doubts'
            ? false
            : rulesOnly
              ? p.confidence >= sure
              : own >= FOLDER_AGREE_FLOOR;
        const to = Math.min(
          raised,
          mayBeSure ? FOLDER_AGREE_MAX : Math.round((sure - 0.01) * 100) / 100,
        );
        return { ...said, confidence: Math.max(p.confidence, to), folder: true };
      }
      // The pages (or the rules) stand; both are said.
      folderClashes.push({ field, folder: fromFolder, other: p.value, rules: rulesOnly });
      return said;
    }
    if (dflt === null) {
      return fromFolder === null
        ? undefined
        : { value: fromFolder, from: 'folder', confidence: FOLDER_CONFIDENCE, cue: null };
    }
    if (!p) return { value: dflt, from: 'batch', confidence: null, cue: null };
    if (p.value === dflt) {
      return rulesOnly
        ? { value: dflt, from: 'batch', confidence: null, cue: null }
        : { value: dflt, from: 'both', confidence: own, cue: p.cue };
    }
    // A rule never disagrees with the batch: the batch's choice stands, silently.
    if (!rulesOnly && own >= CLASH_CONFIDENCE) {
      clashes.push({
        field,
        pages: { value: p.value, confidence: own, cue: p.cue },
        batch: dflt,
      });
    }
    return { value: dflt, from: 'batch', confidence: null, cue: null };
  };

  const proposals: Omit<ItemProposals, 'visibility'> = {};
  const kindS = merge('type_key', kindP, kindD, kindF);
  const personS = merge('owner_member_id', personP, personD, personF);
  if (kindS) proposals.type_key = kindS;
  if (personS) proposals.owner_member_id = personS;
  const kind = kindOf(kindS?.value);

  // Its dates and its number were read for the kind the pages proposed: for
  // another kind (the batch's), they are not offered — nor its issuer.
  // A kind proposed and since deleted counts too: its dates are not the batch's kind's.
  const forKind = !pages.type_key || pages.type_key.value === kindS?.value;
  if (forKind) {
    for (const field of ['issued', 'expires', 'identifier', 'issued_by'] as const) {
      const p = pages[field];
      if (!p) continue;
      // Read at a label the uploader's earlier papers of this layout taught
      // (R1), or made surer by them: learned, not the pages' alone.
      (proposals as Record<string, ItemSuggestion<unknown>>)[field] = {
        value: p.value,
        from: isLearned(p) ? 'learned' : 'pages',
        confidence: p.confidence,
        cue: p.cue,
        ...(p.shape ? { shape: true as const } : {}),
        ...(p.corrected ? { corrected: true as const } : {}),
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

  // Tags from the folder, where the batch chose none (S2): only offered, but
  // one already on a document seen at least as widely as this one would be
  // starts ticked on the card. Never filed by Accept all Ready.
  if (d.tags.length === 0 && folder && folder.tags.length > 0) {
    proposals.tags = folder.tags.map((t) => ({
      value: t.value,
      from: 'folder' as const,
      existing: t.existing,
      ticked: t.existing && t.visibility !== null && NARROW[t.visibility] >= NARROW[vis],
    }));
  }

  // What makes it Check is said once it is read, or its read failed; before
  // that only what is a Problem, or worth knowing, is (the I2 review).
  const check = (t: BatchTag) => {
    if (read || input.reading === 'failed') tags.push(t);
  };
  // A teen's documents are their own: the pages confidently naming somebody
  // else of the family is worth a look, with nobody else to choose.
  const named = pages.owner_member_id;
  if (
    role === 'teen' &&
    named &&
    named.cue !== 'learned' &&
    named.value !== me &&
    (named.page_confidence ?? named.confidence) >= CLASH_CONFIDENCE &&
    people.some((p) => p.id === named.value)
  ) {
    check({
      code: 'not_theirs',
      kind: 'check',
      words: `The pages say ${nameOf(named.value)}: your documents are your own`,
    });
  }
  for (const c of clashes) {
    if (c.field === 'owner_member_id') {
      check({
        code: 'clash_person',
        kind: 'check',
        words: `The pages say ${nameOf(c.pages.value)}, the batch says ${nameOf(c.batch)}`,
      });
    } else {
      check({
        code: 'clash_kind',
        kind: 'check',
        words: `The pages say ${aKind(kindOf(c.pages.value)?.label ?? 'kind')}, the batch says ${aKind(kindOf(c.batch)?.label ?? 'kind')}`,
      });
    }
  }
  // Where a sure rule of the uploader's disagrees with the pages (I4): the
  // pages' stands on the card, and both are said.
  const lc = input.learnedClash;
  if (lc?.type_key && kindS?.from === 'pages' && kindS.value !== lc.type_key) {
    const rule = kindOf(lc.type_key);
    if (rule) {
      check({
        code: 'clash_learned',
        kind: 'check',
        words: `The pages say ${aKind(kindOf(kindS.value)?.label ?? 'kind')}, your earlier choices say ${aKind(rule.label)}`,
      });
    }
  }
  if (
    lc?.owner_member_id &&
    personS?.from === 'pages' &&
    personS.value !== lc.owner_member_id &&
    choosable(lc.owner_member_id)
  ) {
    check({
      code: 'clash_learned',
      kind: 'check',
      words: `The pages say ${nameOf(personS.value)}, your earlier choices say ${nameOf(lc.owner_member_id)}`,
    });
  }
  // Where a sure lesson of a sender's layout gives another date or number
  // than the pages do (R1): the pages' stands, and the item is Check.
  const sender = pages.issued_by?.value ?? null;
  for (const [field, what] of [
    ['expires', 'expiry dates'],
    ['issued', 'issue dates'],
    ['identifier', 'numbers'],
  ] as const) {
    const said = proposals[field];
    const other = lc?.[field];
    if (!other || !said || said.from !== 'pages') continue;
    if (field !== 'identifier' && (said.value as DateValue).date === other) continue;
    check({
      code: 'clash_learned',
      kind: 'check',
      words: `The pages and your earlier papers from ${sender ?? 'this sender'} give different ${what}`,
    });
  }
  // Where the folder it came from says otherwise (S2): the pages' (or the
  // rules') stands on the card, and both are said.
  for (const c of folderClashes) {
    const other = c.rules ? 'your earlier choices say' : 'the pages';
    if (c.field === 'type_key' && c.model) {
      // The reading model's kind alone (R2): the folder's stands.
      check({
        code: 'clash_folder',
        kind: 'check',
        words: `The folder says ${shortName(kindOf(c.folder)) ?? 'another kind'}; the vault’s reading model suggests ${aKind(shortName(kindOf(c.other)) ?? 'kind')}`,
      });
    } else if (c.field === 'type_key') {
      check({
        code: 'clash_folder',
        kind: 'check',
        words: `The folder says ${shortName(kindOf(c.folder)) ?? 'another kind'}; ${
          c.rules ? other : `${other} look like`
        } ${aKind(shortName(kindOf(c.other)) ?? 'kind')}`,
      });
    } else {
      check({
        code: 'clash_folder',
        kind: 'check',
        words: `The folder says ${nameOf(c.folder)}; ${c.rules ? other : `${other} say`} ${nameOf(c.other)}`,
      });
    }
  }
  // A near match (S1): to be looked at, never filed as a new document unseen.
  if (input.renewal && !problem) {
    check({ code: 'renewal', kind: 'check', words: renewalWords(input.renewal) });
  }
  // Unsure: what the pages alone say, the uploader's rules (I4), or the
  // folder alone (S2) — never the batch's.
  const guessed = (s: ItemSuggestion<unknown> | undefined) =>
    s?.from === 'pages' || s?.from === 'learned' || s?.from === 'folder';
  if (kind) {
    if (guessed(kindS) && (kindS?.confidence ?? 0) < ITEM_SURE.type_key) {
      // What the vault's reading model said of it (R2): it suggested this
      // kind alone, or read the page as another.
      const doubted =
        kindS?.from !== 'folder' &&
        pages.type_key?.value === kindS?.value &&
        pages.type_key?.model === 'doubts'
          ? pages.type_key.model_kind
          : undefined;
      check({
        code: 'kind_unsure',
        kind: 'check',
        words:
          kindS?.from === 'folder'
            ? 'Kind from the folder name'
            : kindS?.model === true
              ? 'Kind suggested by the vault’s reading model'
              : doubted
                ? `Kind unsure: the vault’s reading model reads it as ${
                    kindOf(doubted)
                      ? aKind(shortName(kindOf(doubted)) ?? 'kind')
                      : 'none of its kinds'
                  }`
                : 'Kind unsure',
      });
    }
    if (!personS) {
      check({ code: 'person_missing', kind: 'check', words: 'Missing: whose it is' });
    } else if (guessed(personS) && (personS.confidence ?? 0) < ITEM_SURE.owner_member_id) {
      check({
        code: 'person_unsure',
        kind: 'check',
        words: personS.from === 'folder' ? 'Whose it is: from the folder name' : 'Person unsure',
      });
    }
    const missing = missingFields(kind, {
      issued: proposals.issued?.value ?? null,
      expires: proposals.expires?.value ?? null,
      identifier: proposals.identifier?.value ?? null,
      issued_by: proposals.issued_by?.value ?? null,
      // Where the paper copies are, for whoever sees that (seesLocation).
      physical_location: seesLocation(role) ? d.physical_location : null,
      // The batch's tags: a folder's are never filed unasked (S2).
      tags: d.tags,
      notes: null,
      extra: {},
    });
    for (const m of missing) {
      const word = m.label ? lowerFirst(m.label) : (FIELD_WORDS[m.key] ?? lowerFirst(m.key));
      check({
        code: 'missing',
        kind: 'check',
        field: m.key,
        words: `Missing: ${word} (required for ${aKind(kind.label)})`,
      });
    }
    const expires = proposals.expires;
    if (
      guessed(expires) &&
      (expires?.confidence ?? 0) < ITEM_SURE.expires &&
      !missing.some((m) => m.key === 'expires')
    ) {
      check({ code: 'expiry_unsure', kind: 'check', words: 'Expiry unsure' });
    }
    // An end date on the page, not on the card, for a kind complete without
    // one (R3; the re-check): by the kind the card has now, whatever the pages
    // proposed — its own expiry labelled on the page, or an expiry the pages
    // read for the kind they proposed, not offered for this one.
    const labelled = (input.expiryLabels ?? []).includes(kind.key);
    const dropped = !forKind && !!pages.expires;
    if (
      (labelled || dropped) &&
      expiryOptional(kind) &&
      !expires &&
      !missing.some((m) => m.key === 'expires')
    ) {
      check({
        code: 'expiry_unsure',
        kind: 'check',
        words: labelled
          ? 'Expiry on the page, not read'
          : 'Expiry on the page, read for another kind',
      });
    }
    // A date read only once OCR's confusions were put right (R3): never Ready
    // on its own strength.
    const corrected = (['issued', 'expires'] as const).some((f) => {
      const s = proposals[f];
      return !!s && guessed(s) && s.corrected === true;
    });
    if (corrected && !tags.some((t) => t.code === 'expiry_unsure')) {
      check({ code: 'date_corrected', kind: 'check', words: 'A date read from unclear digits' });
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

/**
 * Where a sure rule disagreed with the pages, as the worker sealed it beside
 * the proposal (`{ v: 1, proposal, learned_clash }`, I4): a kind's key or a
 * member's id by field, each kept only if it is a short string. Anything
 * else is none.
 */
export function storedLearnedClash(raw: unknown): LearnedClash {
  const out: LearnedClash = {};
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return out;
  const c = (raw as { learned_clash?: unknown }).learned_clash;
  if (!c || typeof c !== 'object') return out;
  for (const k of ['type_key', 'owner_member_id'] as const) {
    const v = (c as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0 && v.length <= 64) out[k] = v;
  }
  // A sender's layout's (R1): a date, and that a number differs.
  for (const k of ['issued', 'expires'] as const) {
    const v = (c as Record<string, unknown>)[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[k] = v;
  }
  if ((c as Record<string, unknown>).identifier === 'differs') out.identifier = 'differs';
  return out;
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
 * The kinds whose expiry label the worker sealed it found on the pages
 * (`{ v: 1, …, expiry_labels: ['property_deed'] }`, 0.9.0 R3, the re-check):
 * each a short string, at most MAX_EXPIRY_LABEL_KINDS of them. Anything
 * else is none.
 */
export function storedExpiryLabels(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return [];
  const labels = (raw as { expiry_labels?: unknown }).expiry_labels;
  if (!Array.isArray(labels)) return [];
  return labels
    .filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 64)
    .slice(0, MAX_EXPIRY_LABEL_KINDS);
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
    // Only what a proposal is: made surer by the uploader's rules (I4), or not.
    return {
      value: f.value,
      confidence: f.confidence,
      cue: f.cue,
      ...((f as { learned?: unknown }).learned === true ? { learned: true } : {}),
      ...((f as { shape?: unknown }).shape === true ? { shape: true } : {}),
      ...((f as { corrected?: unknown }).corrected === true ? { corrected: true } : {}),
      // What the reading model said of a kind (R2): a word of two, and a kind's key.
      ...(['alone', 'doubts'].includes(String((f as { model?: unknown }).model))
        ? { model: (f as { model: string }).model }
        : {}),
      ...(typeof (f as { model_kind?: unknown }).model_kind === 'string' &&
      /^[a-z0-9_]{1,64}$/.test((f as { model_kind: string }).model_kind)
        ? { model_kind: (f as { model_kind: string }).model_kind }
        : {}),
      ...(typeof (f as { page_confidence?: unknown }).page_confidence === 'number' &&
      (f as { page_confidence: number }).page_confidence >= 0 &&
      (f as { page_confidence: number }).page_confidence <= 1
        ? { page_confidence: (f as { page_confidence: number }).page_confidence }
        : {}),
    } as never;
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
