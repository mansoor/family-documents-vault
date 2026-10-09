import {
  can,
  CATEGORY_LABELS,
  categoryLabel,
  CORE_FIELDS,
  dateReminderSentence,
  deriveStatus,
  leadTimes,
  leadWords,
  nextReminder,
  refusalFor,
  REMIND_ONCE,
  reminderChoices,
  reminderOf,
  reminderSentence,
  reminderWord,
  widensVisibility,
  type AttributeKind,
  type CoreField,
  type CoreFieldRule,
  type DocumentAttributeView,
  type DocumentTypeImpact,
  type DocumentTypeInput,
  type DocumentTypeView,
  type Reminding,
  type ReminderWords,
  type Visibility,
} from '@fdv/shared';
import { Children, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { coreRule } from '../details.js';
import { Button, ConfirmDialog, ErrorNote, Field, Select, Switch, TopBar } from '../ui.js';

/**
 * Settings → Kinds of document (5.12): what the family keeps, and what the
 * card asks for each. Owners and adults (`types.manage`, A6) add kinds of
 * their own, change what any kind asks for, hide the built-ins nobody
 * needs, and archive their own. The vault checks every one of these again;
 * this screen only leaves out what would be refused.
 *
 * Four rules the editor keeps in view:
 *  - What it is, Name, Whose it is and Who can see are on every card (A10):
 *    they are how the vault files, finds and protects a document.
 *  - A field is required only where the card shows it.
 *  - Letting more people see a kind's next document is an owner's decision,
 *    confirmed (5.11); an adult is not offered it.
 *  - What a change would do to the documents already filed is said before
 *    it is saved, counting only what the reader can see, with the sentence
 *    that says there may be others (5.11's /impact).
 */

const LIST = '/settings/kinds';

const VISIBILITY: ReadonlyArray<readonly [Visibility, string]> = [
  ['household', 'Everyone'],
  ['adults', 'Adults only'],
  ['private', 'Only me'],
];

/** On every card, whatever the kind (A10), and why. */
const LOCKED: ReadonlyArray<{ id: string; name: string; why: string }> = [
  { id: 'type', name: 'What it is', why: 'How it is filed, and what the card asks next.' },
  { id: 'title', name: 'Name', why: 'How it is found again.' },
  { id: 'owner', name: 'Whose it is', why: 'Whose papers it is among.' },
  { id: 'visibility', name: 'Who can see it', why: 'Who may open it.' },
];

/** The fixed fields a kind may ask for, in the editor's order, in the app's own words. */
const OPTIONAL: ReadonlyArray<{ field: CoreField; word: string; renamable?: boolean }> = [
  { field: 'issued_by', word: 'Issued by', renamable: true },
  { field: 'identifier', word: 'Number', renamable: true },
  { field: 'issued', word: 'Issued' },
  { field: 'expires', word: 'Expires' },
  { field: 'physical_location', word: 'Where the original is' },
  { field: 'tags', word: 'Tags' },
  { field: 'notes', word: 'Notes' },
];

/** The fixed fields in the order the card asks them, for the preview. */
const CARD_ORDER: ReadonlyArray<CoreField> = [
  'issued_by',
  'issued',
  'expires',
  'identifier',
  'physical_location',
];

const KIND_WORDS: Record<AttributeKind, string> = {
  text: 'Short text',
  long_text: 'Longer text',
  date: 'A date',
  year: 'A year',
  number: 'A number',
  money: 'An amount of money',
  choice: 'A choice from a list',
  yes_no: 'Yes or no',
};

/** Days before it expires the chips offer; a kind's own others are offered too. */
const LEAD_CHOICES = [0, 7, 14, 30, 60, 90, 180, 270];

/** The vault keeps at most eight lead times for a kind. */
const MAX_LEADS = 8;

/** What a kind that expires is reminded, when it says nothing, as the vault does. */
const DEFAULT_LEADS = [30];

/** A13: there is no secret kind of field. */
export const PASSWORD_MANAGER =
  'Passwords and PINs belong in a password manager, not here: everybody who can see a document can read its details.';

/** Said before a field is added: it is the family's at once, and for good. */
export const LIBRARY_AT_ONCE =
  'Adding it puts it in the family’s library straight away, for every kind, even if you don’t save this one. It can’t be taken out again, so check the name first.';

// Reminders from any date (5.16b), in the section's own words.
export const REMINDERS_INTRO =
  'Remind the family before a date on these documents. Everyone who can see a document gets its reminders; nobody else hears of it.';
export const REMINDERS_OFF = 'No reminders: nobody is told about a date on these documents.';
export const DATES_HINT =
  'Dates this kind asks for, above. Show another date to choose it here. Issued isn’t offered: it has already happened when a document is filed.';
/** Reminders on, and nothing to count back from: Save waits. */
export const NO_DATE =
  'This kind asks for no date yet. Show Expires, or a date field such as Due date, above.';
/** Reminders on, and no lead time: Save waits. */
export const NO_LEAD = 'Choose at least one, or switch reminders off.';
/** Beside the reminding field's Required, ticked and locked: the vault keeps it required. */
export const ALWAYS_ASKED = 'Always asked: reminders come from this date.';
/** What the vault can read of an Only me document, for its reminders (A62). */
export const ONLY_ME_DATE =
  'On Only me documents the vault can read this date, as it can an expiry date, so it can remind their owner. Everything else in their details stays sealed.';
/** Expires's note once its reminders have a section of their own. */
export const EXPIRES_NOTE =
  'A document of a kind that expires always needs the date. When to remind is under Reminders.';

const leadLabel = (days: number) => (days === 0 ? 'On the day' : leadWords(days));

/** "its due date", "its MOT": a date field as the vault's own sentence names it. */
const itsName = (label: string) =>
  /before (its .+)\.$/.exec(dateReminderSentence(label, [1]) ?? '')?.[1] ?? `its ${label}`;

/**
 * "a due date", "an MOT", "an expiry date": the words after "Needs" on a
 * document without it, as its status says them (deriveStatus).
 */
const needsWords = (key: string, label: string | null) =>
  deriveStatus(
    {
      type: { key: '', expiry_driver: null, reminder_leads: [] },
      owner_member_id: '-',
      expires: null,
      missing: [{ key, label }],
    },
    '2000-01-01',
  ).label.replace(/^Needs /, '');

/**
 * A field's name in Details: a household's own named like a built-in reads
 * "Due date (your own)", as the dates to remind from name it — by the same
 * rule (reminderChoices).
 */
const ownName = (
  f: { key: string; label: string },
  library: ReadonlyArray<DocumentAttributeView>,
) =>
  reminderChoices({ expiry_driver: null, fields: [{ ...f, kind: 'date' }] }, library)[0]?.label ??
  f.label;

/** "A or B", "A, B or C": the other dates nobody is told before. */
const orList = (words: ReadonlyArray<string>) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1] as string}`;

const visibilityWords = (v: Visibility) => VISIBILITY.find(([key]) => key === v)?.[1] ?? v;

// ------------------------------------------------------------------ the list

export function KindsScreen() {
  const { withToken, authVersion } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const manage = can(storedRole(), 'types.manage');
  const { data, error, setData } = useLoad(
    async (t) => (manage ? (await api.documentTypes(t, { all: true })).items : []),
    [authVersion],
  );
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  // Back from the editor with news: it takes the focus, so it is heard, and
  // leaves the history entry, so a reload does not say it again.
  useEffect(() => {
    if (!notice) return;
    status.current?.focus();
    void navigate(location.pathname, { replace: true, state: null });
    // Only as the list opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hide = async (kind: DocumentTypeView, hidden: boolean) => {
    if (busy.current) return;
    busy.current = kind.key;
    setProblem(null);
    setNotice(null);
    try {
      const changed = await withToken((t) =>
        hidden ? api.archiveDocumentType(t, kind.key) : api.restoreDocumentType(t, kind.key),
      );
      if (!changed) return;
      setData((items) => (items ?? []).map((k) => (k.key === changed.key ? changed : k)));
      setNotice(
        hidden
          ? `“${changed.label}” is no longer offered for new documents. Those already filed keep it.`
          : `“${changed.label}” is offered again.`,
      );
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      busy.current = null;
    }
  };

  if (!manage) {
    return (
      <main className="page page-top has-nav">
        <TopBar
          title="Kinds of document"
          back="/settings/household"
          backLabel="Back to Household"
        />
        <p className="status status-warn">{refusalFor('types.manage')}</p>
      </main>
    );
  }

  const own = (data ?? []).filter((k) => k.builtin === false);
  const builtins = (data ?? []).filter((k) => k.builtin !== false);

  return (
    <main className="page page-top has-nav">
      <TopBar title="Kinds of document" back="/settings/household" backLabel="Back to Household" />
      <p className="lede">
        What the family keeps, and what the card asks for each. Changes are for everyone in the
        household, and in the activity log.
      </p>
      <p role="status" ref={status} tabIndex={-1} className="notice status-line">
        {notice}
      </p>
      <ErrorNote message={problem ?? error} />
      <Link to={`${LIST}/new`} className="btn btn-primary">
        Add a kind
      </Link>
      <section aria-labelledby="kinds-own-h">
        <h2 id="kinds-own-h" className="section-h">
          Your own
        </h2>
        <ul className="list">
          {own.map((k) => (
            <li key={k.key}>
              <KindLink kind={k} />
            </li>
          ))}
          {data !== null && own.length === 0 && (
            <li className="muted">
              None yet. Add one for anything the built-in kinds don’t cover.
            </li>
          )}
        </ul>
      </section>
      <section aria-labelledby="kinds-builtin-h">
        <h2 id="kinds-builtin-h" className="section-h">
          Built in
        </h2>
        <p className="muted">
          Hide one the family never needs: it stops being offered for new documents, and every
          document already filed under it keeps it.
        </p>
        <ul className="list">
          {builtins.map((k) => (
            <li key={k.key}>
              <KindLink kind={k} />
              <Switch
                id={`k-hide-${k.key}`}
                label={`Hide ${k.label}`}
                word="Hide"
                checked={k.hidden === true}
                onChange={(hidden) => void hide(k, hidden)}
              />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function KindLink({ kind }: { kind: DocumentTypeView }) {
  const state = kind.hidden ? (kind.builtin === false ? ' · Archived' : ' · Hidden') : '';
  return (
    <Link to={`${LIST}/${encodeURIComponent(kind.key)}`} className="rowbtn">
      <span className="doc-title">{kind.label}</span>
      <span className="muted">
        {categoryLabel(kind.category)}
        {state}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------- the editor

/** Switched on while the kind asked for no date: the first date it shows is the one. */
const FIRST = Symbol('the first date shown');

/**
 * What was chosen by hand in Reminders (5.16b): a date's key; null,
 * switched off; FIRST; or undefined, nothing — the reminders are then the
 * vault's own rule, worked out on the kind as saved.
 */
type Chosen = string | null | typeof FIRST | undefined;

/** What the reminders just did by themselves: on, from a date and when; or off, its date hidden. */
type RemNotice = { on: string; leads: number[] } | { off: string };

/** What the editor holds while somebody changes it: the kind as it will be saved. */
interface Draft {
  label: string;
  category: string;
  core: Record<CoreField, CoreFieldRule>;
  /**
   * The details it asks for, from the library, in order, each required as
   * the family chose. The date reminders come from is required whatever
   * they chose (`asked`).
   */
  fields: Array<{ key: string; required: boolean }>;
  /**
   * Lead times, in days. Without `features.reminder_dates`, Expires's, as
   * before. With it, those of the date reminders come from — or, while none
   * does, the times Expires kept — as the vault keeps them (reminderOf).
   */
  leads: number[];
  /** The date reminders come from (5.16b): 'expires', a date field's key, or null. */
  from: string | null;
  /** The Reminders switch (5.16b): on with no date while the kind asks for none. */
  reminding: boolean;
  /**
   * What was chosen by hand in Reminders (5.16b). `from`, `leads` and
   * `reminding` are worked out again from it and the kind as saved at every
   * change (`settle`), never from the draft before: so a change undone is
   * undone here too, and saving it sends nothing (the 5.16b review).
   */
  chosen: Chosen;
  /** Lead times chosen by hand with the chips: they stay with whichever date reminds. */
  chosenLeads: number[] | undefined;
  visibility: Visibility;
  essential: boolean;
}

/**
 * The fixed fields as a kind asks for them, read as the card reads them
 * (5.10's coreRule). A vault that says nothing of them (before 0.5.6) shows
 * each, except an expiry for a kind that does not expire; a new kind starts
 * the same way, and does not expire.
 */
function coreOf(kind: DocumentTypeView | null): Record<CoreField, CoreFieldRule> {
  const core = Object.fromEntries(CORE_FIELDS.map((f) => [f, coreRule(kind, f)])) as Record<
    CoreField,
    CoreFieldRule
  >;
  if (!kind?.core) {
    core.expires.shown = Boolean(kind?.expiry_driver);
    core.issued_by.label = kind?.issued_by_label ?? null;
  }
  return core;
}

/** `dated`: the vault has reminders from any date (`features.reminder_dates`, 5.16b). */
function draftOf(kind: DocumentTypeView | null, dated: boolean): Draft {
  const was: Reminding = kind && dated ? reminderOf(kind) : { from: null, leads: [] };
  return {
    label: kind?.label ?? '',
    category: kind?.category ?? 'other',
    core: coreOf(kind),
    fields: (kind?.fields ?? []).map((f) => ({ key: f.key, required: f.required === true })),
    leads: dated ? was.leads : (kind?.reminder_leads ?? []),
    from: was.from,
    reminding: was.from !== null,
    chosen: undefined,
    chosenLeads: undefined,
    visibility: kind?.default_visibility ?? 'household',
    essential: kind?.usually_essential ?? false,
  };
}

/** Whether the draft still asks for a date: Expires shown, or the field on its card. */
const asksForDate = (d: Draft, key: string) =>
  key === 'expires' ? d.core.expires.shown : d.fields.some((f) => f.key === key);

/**
 * The details as the vault will keep them: the date reminders come from is
 * always asked for, so it is required, while it reminds. Moved to another
 * date, it is required as the family chose again.
 */
function asked(d: Draft): Draft['fields'] {
  const from = d.reminding ? d.from : null;
  return from === null || from === 'expires'
    ? d.fields
    : d.fields.map((f) => (f.key === from ? { ...f, required: true } : f));
}

const RENAMABLE = new Set<CoreField>(OPTIONAL.filter((o) => o.renamable).map((o) => o.field));

const tidy = (s: string | null) => s?.trim().replace(/\s+/g, ' ') || null;

const sameLeads = (a: number[], b: number[]) =>
  [...new Set(a)].sort((x, y) => x - y).join() === [...new Set(b)].sort((x, y) => x - y).join();

/** Asked for before the card saves: an expiry always is, for a kind that expires. */
const needed = (f: CoreField, r: CoreFieldRule) => r.shown && (f === 'expires' || r.required);

/** One fixed field's rule as the vault takes it: required only where shown. */
function ruleOut(
  f: CoreField,
  r: CoreFieldRule,
): Pick<CoreFieldRule, 'shown'> & Partial<CoreFieldRule> {
  if (f === 'expires') return { shown: r.shown };
  return {
    shown: r.shown,
    required: r.shown && r.required,
    ...(RENAMABLE.has(f) ? { label: tidy(r.label) } : {}),
  };
}

/**
 * What reminds, as the vault takes it (5.16b): `remind_from` and its lead
 * times, never `reminder_leads`. Whatever the vault would work out the same
 * way by itself is left to it. So hiding the date reminders come from says
 * nothing — the vault switches them off too, and Expires keeps its times
 * for when it is shown again — while switching them off by hand says so,
 * and so does showing Expires again on a kind that reminds nobody: without
 * it, the vault would start reminding from Expires, as it does for older
 * phones (nextReminder).
 */
function remindChange(
  kind: DocumentTypeView,
  d: Draft,
): Pick<DocumentTypeInput, 'remind_from' | 'remind_leads'> {
  const was = reminderOf(kind);
  const from = d.reminding ? d.from : null;
  if (from !== null) {
    if (from !== was.from) return { remind_from: from, remind_leads: leadTimes(d.leads) };
    return sameLeads(d.leads, was.leads) ? {} : { remind_leads: leadTimes(d.leads) };
  }
  const offByHand = was.from !== null && asksForDate(d, was.from);
  const expiresAgain = d.core.expires.shown && !coreOf(kind).expires.shown;
  return offByHand || expiresAgain ? { remind_from: null } : {};
}

/** A new kind, whole. */
function createBody(d: Draft, dated: boolean): DocumentTypeInput {
  const reminds = d.reminding && d.from !== null;
  return {
    label: tidy(d.label) ?? '',
    category: d.category,
    core: Object.fromEntries(CORE_FIELDS.map((f) => [f, ruleOut(f, d.core[f])])),
    fields: asked(d).map((f) => ({ key: f.key, required: f.required })),
    ...(dated
      ? reminds
        ? { remind_from: d.from, remind_leads: leadTimes(d.leads) }
        : { remind_from: null }
      : d.core.expires.shown
        ? { reminder_leads: d.leads }
        : {}),
    default_visibility: d.visibility,
    usually_essential: d.essential,
  };
}

/** A change to a kind: only what is different, so what somebody else changed meanwhile is theirs. */
function changeBody(kind: DocumentTypeView, d: Draft, dated: boolean): DocumentTypeInput {
  const before = draftOf(kind, dated);
  const body: DocumentTypeInput = {};
  if (kind.builtin === false) {
    if (tidy(d.label) !== before.label) body.label = tidy(d.label) ?? '';
    if (d.category !== before.category) body.category = d.category;
  }
  const core: NonNullable<DocumentTypeInput['core']> = {};
  for (const f of CORE_FIELDS) {
    const was = before.core[f];
    const now = ruleOut(f, d.core[f]);
    const change: Partial<CoreFieldRule> = {};
    if (now.shown !== was.shown) change.shown = now.shown;
    if (now.required !== undefined && now.required !== was.required) change.required = now.required;
    if (now.label !== undefined && now.label !== (tidy(was.label) ?? null))
      change.label = now.label;
    if (Object.keys(change).length > 0) core[f] = change;
  }
  if (Object.keys(core).length > 0) body.core = core;
  const fields = asked(d);
  if (JSON.stringify(fields) !== JSON.stringify(before.fields)) {
    body.fields = fields.map((f) => ({ key: f.key, required: f.required }));
  }
  if (dated) Object.assign(body, remindChange(kind, d));
  else if (d.core.expires.shown && !sameLeads(d.leads, before.leads)) body.reminder_leads = d.leads;
  if (d.visibility !== before.visibility) body.default_visibility = d.visibility;
  if (d.essential !== before.essential) body.usually_essential = d.essential;
  return body;
}

export function KindScreen() {
  const { key } = useParams();
  const { authVersion } = useApp();
  const manage = can(storedRole(), 'types.manage');
  const { data, error, reload } = useLoad(
    async (t) => {
      if (!manage) return null;
      const [types, library] = await Promise.all([
        api.documentTypes(t, { all: true }),
        api.documentAttributes(t),
      ]);
      return { types: types.items, library: library.items };
    },
    [authVersion, key],
  );
  // How many times "Load the latest" has started the editor again.
  const [reloads, setReloads] = useState(0);
  const kind = key === undefined ? null : data?.types.find((k) => k.key === key);

  if (!manage || error || !data || kind === undefined) {
    return (
      <main className="page page-top">
        <TopBar title={key === undefined ? 'Add a kind' : 'Kind of document'} back={LIST} />
        {!manage ? (
          <p className="status status-warn">{refusalFor('types.manage')}</p>
        ) : error ? (
          <ErrorNote message={error} />
        ) : !data ? (
          <p className="muted">Loading…</p>
        ) : (
          <p className="muted">That kind of document is not on the list.</p>
        )}
      </main>
    );
  }
  // A new start whenever the kind itself changes, and after "Load the
  // latest", which says so.
  return (
    <KindEditor
      key={`${kind?.etag ?? kind?.key ?? 'new'}#${reloads}`}
      kind={kind}
      library={data.library}
      reloaded={reloads > 0}
      onReload={() => void reload().then(() => setReloads((n) => n + 1))}
    />
  );
}

function KindEditor(props: {
  kind: DocumentTypeView | null;
  library: DocumentAttributeView[];
  /** Started again by "Load the latest": it says what it loaded, and takes the focus. */
  reloaded: boolean;
  onReload: () => void;
}) {
  const { kind } = props;
  const { withToken, guarded, caps } = useApp();
  const navigate = useNavigate();
  const role = storedRole();
  const mayWiden = can(role, 'types.widen_visibility');
  const builtin = kind !== null && kind.builtin !== false;
  // Reminders from any date, with a section of their own (5.16b). A vault
  // without them keeps today's editor: the chips under Expires.
  const dated = caps?.features.reminder_dates === true;
  // The draft, the library a field added here joins, and what the editor
  // just did to the reminders by itself, said as it happens: one state, so
  // every change is made to the latest of all three, even one landing after
  // an await (the 5.16b review).
  const [{ draft, library, remNotice }, setEditor] = useState(() => ({
    draft: draftOf(kind, dated),
    library: props.library,
    remNotice: null as RemNotice | null,
  }));
  /** A change nothing about the reminders follows. */
  const edit = (change: (d: Draft) => Draft) =>
    setEditor((e) => ({ ...e, draft: change(e.draft) }));
  // The library's rows keep their places while fields are shown and hidden:
  // the kind's own first, as it asks them, then the rest by name.
  const [order, setOrder] = useState(() => {
    const own = (kind?.fields ?? []).map((f) => f.key);
    const rest = props.library
      .filter((a) => !own.includes(a.key))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((a) => a.key);
    return [...own, ...rest];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const archiveButton = useRef<HTMLButtonElement>(null);
  const loadedLine = useRef<HTMLParagraphElement>(null);
  // The button pressed has gone with the old copy: the place is on what
  // was loaded instead, so it is heard.
  useEffect(() => {
    if (props.reloaded) loadedLine.current?.focus();
    // Only as this copy opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const impact = useLoad(
    async (t) => (kind ? api.documentTypeImpact(t, kind.key) : null),
    [kind?.key, kind?.etag],
  );

  const review = kind?.expiry_driver === 'review_on';
  const wordFor = (f: CoreField) =>
    f === 'expires' && review ? 'Review by' : (OPTIONAL.find((o) => o.field === f)?.word ?? f);
  /** A fixed field's name on the card: the kind's, or the app's own word. */
  const cardName = (f: CoreField) => tidy(draft.core[f].label) ?? wordFor(f);
  const fieldOf = (key: string, lib: ReadonlyArray<DocumentAttributeView> = library) => {
    const had = kind?.fields.find((f) => f.key === key);
    const known = lib.find((a) => a.key === key);
    return {
      key,
      label: had?.label ?? known?.label ?? key,
      kind: had?.kind ?? known?.kind ?? 'text',
    };
  };

  // ---- reminders from any date (5.16b), by the vault's own rules ----

  /** The kind as the draft will save it, as the vault's rules read it. */
  const asType = (
    d: Draft,
    lib: ReadonlyArray<DocumentAttributeView> = library,
  ): ReminderWords => ({
    expiry_driver: d.core.expires.shown ? (kind?.expiry_driver ?? 'expires_on') : null,
    core: { expires: { label: d.core.expires.label } },
    fields: d.fields.map((f) => fieldOf(f.key, lib)),
  });
  /** The dates it can remind from, in its words and its order (reminderChoices). */
  const datesOf = (d: Draft, lib: ReadonlyArray<DocumentAttributeView> = library) =>
    reminderChoices(asType(d, lib), lib);
  /** The kind as saved, where the vault's rule starts from (`nextReminder`). */
  const asSaved = {
    reminding: kind && dated ? reminderOf(kind) : { from: null, leads: [] },
    expires: coreOf(kind).expires.shown,
  };

  /**
   * The draft's reminders, worked out again at every change, by the vault's
   * own rule (nextReminder), from the kind as saved and what was chosen by
   * hand — never from the draft before, so a change undone is undone here
   * too (the 5.16b review). Hiding the date they come from switches them
   * off, and showing it again brings them back as they were; showing
   * Expires on a kind that reminds nobody, and never showed it, switches
   * them on, 30 days before unless it kept its own times; switched on
   * while the kind asked for no date, the first date shown is chosen; a
   * date chosen by hand and hidden since is off until it is shown again.
   * `lib` is the library with any field just added to it.
   */
  const settle = (d: Draft, lib: ReadonlyArray<DocumentAttributeView>): Draft => {
    if (!dated) return d;
    const keys = datesOf(d, lib).map((c) => c.key);
    const shape = { expires: d.core.expires.shown, dates: keys.filter((k) => k !== 'expires') };
    let chosen = d.chosen;
    if (chosen === FIRST) {
      if (keys.length === 0) return { ...d, reminding: true, from: null, leads: [] };
      // The date it reminds from as saved, while shown: switched off and on
      // again, a kind is as it was. Else Expires, or the first date shown.
      const was = asSaved.reminding.from;
      chosen = was !== null && keys.includes(was) ? was : keys[0];
    }
    const out = nextReminder(
      chosen === undefined
        ? {}
        : { remind_from: chosen !== null && !keys.includes(chosen) ? null : chosen },
      asSaved,
      shape,
    );
    if ('problem' in out) return { ...d, chosen };
    return {
      ...d,
      chosen,
      from: out.from,
      reminding: out.from !== null,
      leads: out.from !== null && d.chosenLeads !== undefined ? d.chosenLeads : out.leads,
    };
  };

  /** What the reminders did by themselves: said as it happens. */
  const byItself = (was: Draft, now: Draft): RemNotice | null =>
    !dated || now.from === was.from
      ? null
      : now.from !== null
        ? { on: now.from, leads: now.leads }
        : was.from !== null
          ? { off: was.from }
          : null;

  /**
   * A change, made to the latest draft (never the one this page was drawn
   * with: a field added lands after an await), with what the reminders do
   * after it, said.
   */
  const change = (apply: (d: Draft) => Draft, say = byItself) =>
    setEditor((e) => {
      const next = settle(apply(e.draft), e.library);
      return { ...e, draft: next, remNotice: say(e.draft, next) };
    });

  /**
   * A date field's name in what is said of reminders: its label, or, beside
   * another date of the same name the draft shows, the chooser's — "Due
   * date (your own)" — so no sentence names two dates alike. So too for a
   * date just hidden, or one they came from as saved.
   */
  const spoken = (key: string, d: Draft) => {
    const label = fieldOf(key).label;
    // Without the section, nothing is told apart, as before.
    if (!dated) return label;
    const alike = (other: string) => other.trim().toLowerCase() === label.trim().toLowerCase();
    const beside = datesOf(d).some(
      (c) => c.key !== 'expires' && c.key !== key && alike(fieldOf(c.key).label),
    );
    return beside ? ownName({ key, label }, library) : label;
  };
  /** "its due date", "it expires": the date, as the sentences say it. */
  const whenOf = (key: string, d: Draft) =>
    key === 'expires'
      ? asType(d).expiry_driver === 'review_on'
        ? 'it’s due for review'
        : 'it expires'
      : itsName(spoken(key, d));
  /**
   * The promise for a date and its lead times, in the vault's own sentence;
   * `label` names a date field as the card does.
   */
  const promiseOf = (key: string, leads: number[], d: Draft, label = spoken(key, d)) =>
    key === 'expires'
      ? reminderSentence({ expiry_driver: asType(d).expiry_driver, reminder_leads: leads })
      : dateReminderSentence(label, leads);
  /** "Reminders are on: 30 days before it expires." */
  const onNotice = (key: string, leads: number[], d: Draft) =>
    `Reminders are on: ${(promiseOf(key, leads, d) ?? '').replace(/^We'll remind you /, '')}`;
  /** "Reminders are off: this kind no longer asks for its due date." */
  const offNotice = (key: string) =>
    `Reminders are off: this kind no longer asks for ${
      key === 'expires'
        ? review
          ? 'its review date'
          : 'its expiry date'
        : itsName(spoken(key, draft))
    }.`;

  /** A field shown or hidden, or its Required changed. */
  const withField = (d: Draft, key: string, shown: boolean, required: boolean): Draft => {
    const at = d.fields.findIndex((f) => f.key === key);
    return {
      ...d,
      fields: !shown
        ? d.fields.filter((f) => f.key !== key)
        : at < 0
          ? [...d.fields, { key, required }]
          : d.fields.map((f) => (f.key === key ? { key, required } : f)),
    };
  };

  const setRule = (f: CoreField, to: Partial<CoreFieldRule>) =>
    change((d) => {
      const rule = { ...d.core[f], ...to };
      // Hidden, it cannot be required.
      if (!rule.shown) rule.required = false;
      const next = { ...d, core: { ...d.core, [f]: rule } };
      // Without the section, Expires switched on is reminded 30 days before, as always.
      if (!dated && f === 'expires' && rule.shown && d.leads.length === 0) {
        next.leads = DEFAULT_LEADS;
      }
      return next;
    });
  const setField = (key: string, shown: boolean, required: boolean) =>
    change((d) => withField(d, key, shown, required));
  /**
   * A field of the family's own, just added to the library and shown: the
   * dates to remind from are worked out with it in the library, so a date
   * field added while reminders wait for one is chosen (the 5.16b review).
   */
  const addField = (a: DocumentAttributeView) =>
    setEditor((e) => {
      const lib = [...e.library, a];
      const next = settle(withField(e.draft, a.key, true, false), lib);
      return { draft: next, library: lib, remNotice: byItself(e.draft, next) };
    });

  /**
   * The switch. On, it picks Expires if the kind shows it, else its first
   * date, with that date's own lead times (defaultLeads, through the
   * vault's rule): as saved, when it is the date the kind reminds from.
   * Off, nothing reminds, whatever the card shows.
   */
  const switchTo = (on: boolean) =>
    change(
      (d) => ({ ...d, chosen: on ? FIRST : null, chosenLeads: undefined }),
      on ? byItself : () => null,
    );

  /** Another date: with the chips untouched, its own lead times, as the vault gives them. */
  const choose = (key: string) =>
    change(
      (d) => ({ ...d, chosen: key }),
      // Chips chosen by hand stay as they were: nothing to say.
      (was, now) => (now.chosenLeads !== undefined ? null : byItself(was, now)),
    );

  const setLeads = (leads: number[]) =>
    change(
      (d) => ({ ...d, chosenLeads: leads }),
      () => null,
    );

  /** What Save waits for in Reminders: a date, and a lead time. */
  const remindProblem =
    dated && draft.reminding
      ? draft.from === null
        ? NO_DATE
        : draft.leads.length === 0
          ? NO_LEAD
          : null
      : null;

  const save = async () => {
    const label = tidy(draft.label);
    if (!builtin && !label) {
      setError('Give the kind of document a name.');
      return;
    }
    if (remindProblem) {
      setError(remindProblem);
      (remindProblem === NO_DATE
        ? document.getElementById('k-rem-on')
        : document.querySelector<HTMLElement>('[aria-labelledby="k-rem-leads-l"] button')
      )?.focus();
      return;
    }
    const body = kind ? changeBody(kind, draft, dated) : createBody(draft, dated);
    if (kind && Object.keys(body).length === 0) {
      void navigate(LIST, { state: { notice: 'Nothing had changed.' } });
      return;
    }
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const saved = await guarded((t) =>
        kind
          ? api.updateDocumentType(t, kind.key, body, kind.etag)
          : api.createDocumentType(t, body),
      );
      if (!saved) {
        setError('Nothing was saved.');
        return;
      }
      void navigate(LIST, {
        state: {
          notice: kind ? `“${saved.label}” is saved.` : `“${saved.label}” is ready to use.`,
        },
      });
    } catch (err) {
      setConflict(err instanceof ApiRequestError && err.code === 'conflict');
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const offer = async (again: boolean) => {
    if (!kind) return;
    setArchiving(true);
    setError(null);
    try {
      const changed = await withToken((t) =>
        again ? api.restoreDocumentType(t, kind.key) : api.archiveDocumentType(t, kind.key),
      );
      if (!changed) return;
      void navigate(LIST, {
        state: {
          notice: again
            ? `“${changed.label}” is offered again.`
            : `“${changed.label}” is archived. Every document filed under it keeps it.`,
        },
      });
    } catch (err) {
      setAsking(false);
      setError(describeError(err));
    } finally {
      setArchiving(false);
    }
  };

  const shownKeys = new Set(draft.fields.map((f) => f.key));
  const expires = draft.core.expires;
  const reminder = reminderSentence({
    expiry_driver: expires.shown ? (kind?.expiry_driver ?? 'expires_on') : null,
    reminder_leads: draft.leads,
  });
  // Reminders from any date (5.16b): the dates it can remind from, the one
  // that does, and what is said of it.
  const dates = dated ? datesOf(draft) : [];
  const reminds = dated && draft.reminding ? draft.from : null;
  const labelOf = (key: string) =>
    dates.find((c) => c.key === key)?.label ?? reminderWord(asType(draft), key, library);
  const promise = reminds ? promiseOf(reminds, draft.leads, draft) : null;
  const others = dates.filter((c) => c.key !== reminds);
  // When it shows two dates, which one reminds, plainly.
  const which =
    reminds && others.length > 0
      ? `Only ${labelOf(reminds)} reminds: nobody is told before ${orList(
          others.map((c) => whenOf(c.key, draft)),
        )}${
          others.some((c) => c.key === 'expires')
            ? `, and its badge warns only on the day ${whenOf('expires', draft)}`
            : ''
        }.`
      : null;
  const says: string[] =
    reminds && promise
      ? reminds === 'expires'
        ? [promise, ...(which ? [which] : [])]
        : [
            promise,
            ...(which ? [which] : []),
            REMIND_ONCE,
            `Every document of this kind needs ${itsName(spoken(reminds, draft))}: without one it reads Needs ${needsWords(reminds, fieldOf(reminds).label)}.`,
            ONLY_ME_DATE,
          ]
      : [];
  // The preview says it in the card's own words: under the date it is about.
  const cardPromise = reminds
    ? promiseOf(reminds, draft.leads, draft, fieldOf(reminds).label)
    : null;
  const noticeText =
    remNotice === null
      ? null
      : 'off' in remNotice
        ? offNotice(remNotice.off)
        : onNotice(remNotice.on, remNotice.leads, draft);
  // The kind's own lead times stay chips while off, for the date it keeps them for.
  const kept = kind && dated ? reminderOf(kind) : null;
  const savedLeads = kept && kept.from === draft.from ? kept.leads : [];

  const saved = kind?.default_visibility;
  const narrowOnly = saved !== undefined && !mayWiden;
  const warnings =
    kind && impact.data
      ? warningsFor(kind, draft, impact.data, {
          dated,
          wordFor,
          fieldOf,
          labelOf,
          spoken: (key) => spoken(key, draft),
          wasWord: (key) =>
            key === 'expires' ? reminderWord(kind, key, library) : spoken(key, draft),
        })
      : [];

  return (
    <main className="page page-top">
      <TopBar title={kind ? kind.label : 'Add a kind'} back={LIST} />
      {builtin ? (
        <p className="lede">
          Built in: it keeps its name, and it is filed under {categoryLabel(kind.category)}. What
          the card asks is the family’s to change.
        </p>
      ) : (
        <p className="lede">
          {kind
            ? 'The family’s own. Its documents keep it whatever it is called.'
            : 'For anything the built-in kinds don’t cover. The phone and the web offer it as soon as it is saved.'}
        </p>
      )}
      <p role="status" ref={loadedLine} tabIndex={-1} className="notice status-line">
        {props.reloaded
          ? 'This is the latest, with the other change in it. Your changes weren’t kept: make them again, then save.'
          : null}
      </p>
      {kind?.hidden && (
        <p className="status status-warn">
          {builtin
            ? 'Hidden: it is not offered for new documents. The switch in the list offers it again.'
            : 'Archived: it is not offered for new documents.'}
        </p>
      )}

      {!builtin && (
        <section aria-labelledby="k-about-h" className="stack">
          <h2 id="k-about-h" className="section-h">
            About it
          </h2>
          <Field
            id="k-label"
            label="Name of this kind"
            value={draft.label}
            onChange={(label) => edit((d) => ({ ...d, label }))}
            required={false}
            placeholder="Allotment tenancy"
          />
          <Select
            id="k-category"
            label="Category"
            value={draft.category}
            onChange={(category) => edit((d) => ({ ...d, category }))}
            options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
            hint="Where it sits in the lists, on the web and on the phone."
          />
        </section>
      )}

      <section aria-labelledby="k-card-h">
        <h2 id="k-card-h" className="section-h">
          On the card
        </h2>
        <p className="muted">
          Every kind asks for the first four: they are how the vault files a document, finds it and
          decides who can open it. The rest are the family’s choice. A required field is asked for
          before the card saves, and a document without it says what it needs.
        </p>
        <ul className="kind-fields">
          {LOCKED.map((l) => (
            <FieldRow key={l.id} id={`k-${l.id}`} name={l.name} why={l.why} locked />
          ))}
          {OPTIONAL.map(({ field, renamable }) => (
            <FieldRow
              key={field}
              id={`k-${field}`}
              name={wordFor(field)}
              shown={draft.core[field].shown}
              required={draft.core[field].required}
              requiredOffered={field !== 'expires'}
              onShown={(shown) => setRule(field, { shown })}
              onRequired={(required) => setRule(field, { required })}
            >
              {renamable && (
                <Field
                  id={`k-${field}-label`}
                  label="What the card calls it"
                  value={draft.core[field].label ?? ''}
                  onChange={(label) => setRule(field, { label })}
                  required={false}
                  placeholder={wordFor(field)}
                />
              )}
              {field === 'expires' &&
                (dated ? (
                  <p className="muted">{EXPIRES_NOTE}</p>
                ) : (
                  <>
                    <p className="muted">
                      A document of a kind that expires always needs the date.
                    </p>
                    <LeadChips
                      id="k-leads-l"
                      label={`Remind us before ${review ? 'it’s due for review' : 'it expires'}`}
                      leads={draft.leads}
                      saved={kind?.reminder_leads ?? []}
                      onChange={(leads) => edit((d) => ({ ...d, leads }))}
                    />
                    <p className="muted">
                      {reminder ?? 'No reminders: nobody is told before the day.'}
                    </p>
                  </>
                ))}
            </FieldRow>
          ))}
        </ul>
      </section>

      <section aria-labelledby="k-details-h" className="stack">
        <h2 id="k-details-h" className="section-h">
          Details
        </h2>
        <p className="muted">
          Fields from the library every kind shares. Show one to ask for it on this kind’s card.
        </p>
        <ul className="kind-fields">
          {order.map((key) => {
            const f = fieldOf(key);
            const mine = draft.fields.find((x) => x.key === key);
            return (
              <FieldRow
                key={key}
                id={`k-f-${key}`}
                // A household's own named like a built-in: "Due date (your own)".
                name={dated ? ownName(f, library) : f.label}
                what={KIND_WORDS[f.kind]}
                shown={shownKeys.has(key)}
                required={mine?.required ?? false}
                requiredOffered
                requiredLocked={reminds === key ? ALWAYS_ASKED : undefined}
                onShown={(shown) => setField(key, shown, false)}
                onRequired={(required) => setField(key, true, required)}
              />
            );
          })}
        </ul>
        <p role="status" className="notice status-line">
          {added}
        </p>
        <AddOwnField
          library={library}
          onAdded={(a) => {
            setOrder((o) => {
              const at = o.findIndex((k) => !shownKeys.has(k));
              return at < 0 ? [...o, a.key] : [...o.slice(0, at), a.key, ...o.slice(at)];
            });
            addField(a);
            setAdded(`“${a.label}” is on the card now, and in the library for every kind.`);
          }}
        />
      </section>

      {dated && (
        <section aria-labelledby="k-rem-h" className="stack">
          <h2 id="k-rem-h" className="section-h">
            Reminders
          </h2>
          <p className="muted">{REMINDERS_INTRO}</p>
          <Switch
            id="k-rem-on"
            label="Remind us before a date"
            checked={draft.reminding}
            onChange={switchTo}
          />
          <p role="status" className="notice status-line">
            {noticeText}
          </p>
          {!draft.reminding && <p className="muted">{REMINDERS_OFF}</p>}
          {reminds !== null && (
            <>
              <Select
                id="k-rem-from"
                label="The date"
                value={reminds}
                onChange={choose}
                options={dates.map((c) => ({ value: c.key, label: c.label }))}
                hint={DATES_HINT}
                describedBy="k-rem-says"
              />
              <LeadChips
                id="k-rem-leads-l"
                label="How long before"
                leads={draft.leads}
                saved={savedLeads}
                onChange={setLeads}
              />
              <div id="k-rem-says" className="stack kind-rem-says">
                {says.map((s) => (
                  <p key={s} className="muted">
                    {s}
                  </p>
                ))}
              </div>
            </>
          )}
          {/* What Save waits for, heard as it comes. */}
          <p role="status" className="status-line">
            {remindProblem}
          </p>
        </section>
      )}

      <section aria-labelledby="k-new-h" className="stack">
        <h2 id="k-new-h" className="section-h">
          A new one
        </h2>
        <div className="field" role="group" aria-labelledby="k-visibility-l">
          <span id="k-visibility-l" className="field-label">
            Who can see a new one
          </span>
          <div className="pills">
            {VISIBILITY.map(([v, words]) => {
              const wider = saved !== undefined && widensVisibility(saved, v);
              return (
                <button
                  key={v}
                  type="button"
                  className={`pill${draft.visibility === v ? ' pill-on' : ''}`}
                  aria-pressed={draft.visibility === v}
                  disabled={wider && !mayWiden}
                  onClick={() => edit((d) => ({ ...d, visibility: v }))}
                >
                  {words}
                </button>
              );
            })}
          </div>
          {narrowOnly && saved !== 'household' && (
            <span className="muted">{refusalFor('types.widen_visibility')}</span>
          )}
          {saved !== undefined && mayWiden && widensVisibility(saved, draft.visibility) && (
            <span className="muted">
              More people will see the next one anybody files, a phone’s queued scan included.
              Saving asks you to confirm it’s you.
            </span>
          )}
          {draft.visibility === 'adults' && (
            <span className="muted">
              Teens can’t open one, so one a teen files starts as their Only me.
            </span>
          )}
          {draft.visibility === 'private' && (
            <span className="muted">
              Only the person it belongs to can open one. One filed for somebody else starts as
              Adults only instead, and whoever files it can change that.
            </span>
          )}
        </div>
        <div className="check">
          <input
            id="k-essential"
            type="checkbox"
            checked={draft.essential}
            onChange={(e) => edit((d) => ({ ...d, essential: e.target.checked }))}
          />
          <label htmlFor="k-essential">
            Usually Essential
            <span className="muted">
              A new one is marked Essential, unless whoever files it says otherwise.
            </span>
          </label>
        </div>
      </section>

      <Preview
        label={builtin ? (kind?.label ?? '') : draft.label}
        draft={draft}
        cardName={cardName}
        fieldOf={fieldOf}
        reminder={dated ? cardPromise : expires.shown ? reminder : null}
        remindAt={dated ? reminds : null}
      />

      <div className="kind-warnings" aria-live="polite">
        {warnings.length > 0 && (
          <>
            <p className="field-label">Before you save</p>
            <ul>
              {warnings.map((w) => (
                <li key={w.key}>{w.text}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      {impact.error && (
        <p className="muted">
          The vault couldn’t say how many documents this would touch. You can still save.
        </p>
      )}

      <ErrorNote message={error} />
      {conflict && (
        <Button kind="quiet" onClick={props.onReload}>
          Load the latest
        </Button>
      )}
      <Button disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : kind ? 'Save' : 'Add this kind'}
      </Button>

      {kind && !builtin && !kind.hidden && (
        <button
          ref={archiveButton}
          type="button"
          className="btn btn-quiet"
          onClick={() => setAsking(true)}
        >
          Archive this kind
        </button>
      )}
      {kind && !builtin && kind.hidden && (
        <Button kind="quiet" disabled={archiving} onClick={() => void offer(true)}>
          {archiving ? 'Offering it again…' : 'Offer it again'}
        </Button>
      )}
      {asking && kind && (
        <ConfirmDialog
          title={`Archive “${kind.label}”?`}
          confirmLabel="Archive"
          busyLabel="Archiving…"
          busy={archiving}
          returnFocus={archiveButton}
          onConfirm={() => void offer(false)}
          onCancel={() => setAsking(false)}
        >
          <p>
            It won’t be offered for new documents. Every document filed under it keeps it, with its
            details and its history, and you can offer it again from here.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

/**
 * One field on the card: shown or not, and required only while shown. The
 * four every kind asks for are checked and cannot be unchecked, with the
 * reason beside them (A10).
 */
function FieldRow(props: {
  id: string;
  name: string;
  /** What kind of field it is, or why a locked one is there. */
  what?: string;
  why?: string;
  locked?: boolean;
  shown?: boolean;
  required?: boolean;
  requiredOffered?: boolean;
  /** Why Required is ticked and cannot be unticked: reminders come from it (5.16b). */
  requiredLocked?: string | undefined;
  onShown?: (shown: boolean) => void;
  onRequired?: (required: boolean) => void;
  children?: ReactNode;
}) {
  const shown = props.locked === true || props.shown === true;
  const note = props.why ?? props.what;
  const lockedWhy = shown && props.requiredLocked ? `${props.id}-required-why` : undefined;
  return (
    <li>
      {/* A group named for the field: its Show and Required are its own. */}
      <div className="kind-field" role="group" aria-labelledby={`${props.id}-name`}>
        <div className="kind-field-name">
          <span id={`${props.id}-name`} className="doc-title">
            {props.name}
          </span>
          {note && (
            <span id={`${props.id}-note`} className="muted">
              {note}
            </span>
          )}
        </div>
        <div className="kind-checks">
          <div className="check">
            <input
              id={`${props.id}-shown`}
              type="checkbox"
              checked={shown}
              disabled={props.locked}
              aria-describedby={props.locked ? `${props.id}-note` : undefined}
              onChange={(e) => props.onShown?.(e.target.checked)}
            />
            <label htmlFor={`${props.id}-shown`}>{props.locked ? 'Always asked' : 'Show'}</label>
          </div>
          {/* Required is offered only on a shown field. */}
          {!props.locked && shown && props.requiredOffered && (
            <div className="check">
              <input
                id={`${props.id}-required`}
                type="checkbox"
                checked={props.required === true || lockedWhy !== undefined}
                disabled={lockedWhy !== undefined}
                aria-describedby={lockedWhy}
                // Locked, it keeps what the family chose for when it is not.
                onChange={(e) => lockedWhy === undefined && props.onRequired?.(e.target.checked)}
              />
              <label htmlFor={`${props.id}-required`}>Required</label>
            </div>
          )}
        </div>
        {!props.locked &&
          shown &&
          (lockedWhy !== undefined || Children.toArray(props.children).length > 0) && (
            <div className="kind-field-more stack">
              {lockedWhy && (
                <p id={lockedWhy} className="muted">
                  {props.requiredLocked}
                </p>
              )}
              {props.children}
            </div>
          )}
      </div>
    </li>
  );
}

/**
 * When to remind, before the date: chips, at most eight on. A time of the
 * kind's own (45 days) is a chip too, and stays one while it is off, so it
 * can be turned on again and the place stays on it. Named by `id`: under
 * Expires "Remind us before it expires", in Reminders "How long before"
 * (5.16b).
 */
function LeadChips(props: {
  id: string;
  label: string;
  leads: number[];
  /** The lead times as saved. */
  saved: number[];
  onChange: (leads: number[]) => void;
}) {
  const offered = [...new Set([...LEAD_CHOICES, ...props.saved, ...props.leads])].sort(
    (a, b) => a - b,
  );
  const full = props.leads.length >= MAX_LEADS;
  return (
    <div className="field" role="group" aria-labelledby={props.id}>
      <span id={props.id} className="field-label">
        {props.label}
      </span>
      <div className="pills">
        {offered.map((days) => {
          const on = props.leads.includes(days);
          return (
            <button
              key={days}
              type="button"
              className={`pill${on ? ' pill-on' : ''}`}
              aria-pressed={on}
              disabled={!on && full}
              onClick={() =>
                props.onChange(on ? props.leads.filter((d) => d !== days) : [...props.leads, days])
              }
            >
              {leadLabel(days)}
            </button>
          );
        })}
      </div>
      {full && <span className="muted">Eight at most.</span>}
    </div>
  );
}

/**
 * A field of the household's own, for the library, shown on this kind at
 * once. It goes into the library as it is added, for every kind, and there
 * is no taking it out: that is said before, and a name the library already
 * has is not added twice (the 5.12 review).
 */
function AddOwnField(props: {
  library: DocumentAttributeView[];
  onAdded: (a: DocumentAttributeView) => void;
}) {
  const { withToken } = useApp();
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AttributeKind>('text');
  const [choices, setChoices] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const name = tidy(label);
    const answers = choices
      .split(/[,\n]/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (!name) {
      setError('Give the field a name.');
      return;
    }
    const same = props.library.find((a) => tidy(a.label)?.toLowerCase() === name.toLowerCase());
    if (same) {
      setError(
        `The library already has “${same.label}”. Tick Show beside it in the list above instead.`,
      );
      return;
    }
    if (kind === 'choice' && answers.length === 0) {
      setError('Give a choice at least one answer.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const made = await withToken((t) =>
        api.createDocumentAttribute(t, {
          label: name,
          kind,
          ...(kind === 'choice' ? { choices: answers } : {}),
        }),
      );
      if (!made) return;
      props.onAdded(made);
      setLabel('');
      setChoices('');
      setKind('text');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="k-own-h">
      <h3 id="k-own-h" className="kind-h3">
        Add your own field
      </h3>
      <p className="muted">{PASSWORD_MANAGER}</p>
      <form onSubmit={(e) => void add(e)} className="stack">
        <Field
          id="k-own-label"
          label="What it’s called"
          value={label}
          onChange={setLabel}
          required={false}
          placeholder="Membership number"
        />
        <Select
          id="k-own-kind"
          label="What it holds"
          value={kind}
          onChange={(v) => setKind(v as AttributeKind)}
          options={Object.entries(KIND_WORDS).map(([value, words]) => ({ value, label: words }))}
        />
        {kind === 'choice' && (
          <Field
            id="k-own-choices"
            label="The answers to choose from"
            value={choices}
            onChange={setChoices}
            required={false}
            hint="Separated by commas: Gold, Silver, Bronze"
          />
        )}
        <p id="k-own-library" className="muted">
          {LIBRARY_AT_ONCE}
        </p>
        <ErrorNote message={error} />
        <Button type="submit" kind="quiet" disabled={busy} describedBy="k-own-library">
          {busy ? 'Adding…' : 'Add this field'}
        </Button>
      </form>
    </section>
  );
}

/** The card as it will ask, live: the fixed fields, the details, who can see a new one. */
function Preview(props: {
  label: string;
  draft: Draft;
  cardName: (f: CoreField) => string;
  fieldOf: (key: string) => { label: string };
  reminder: string | null;
  /**
   * The date the reminder is about (5.16b): its promise is said under it,
   * as the card says it. Null: said after the card, as before.
   */
  remindAt: string | null;
}) {
  const { draft, remindAt } = props;
  const row = (key: string, name: string, required: boolean, about: string | null = null) => (
    <li key={key} className={about && props.reminder ? 'kind-preview-remind' : undefined}>
      <span>{name}</span>
      {required && (
        <span className="muted">
          <span aria-hidden="true">* </span>required
        </span>
      )}
      {about && props.reminder && <p className="muted">{props.reminder}</p>}
    </li>
  );
  return (
    <section aria-labelledby="k-preview-h" className="card stack kind-preview">
      <h2 id="k-preview-h" className="section-h">
        How the card will look
      </h2>
      <p className="doc-title">{tidy(props.label) ?? 'A new kind'}</p>
      <ol>
        {LOCKED.slice(0, 3).map((l) => row(l.id, l.name, false))}
        {CARD_ORDER.filter((f) => draft.core[f].shown).map((f) =>
          row(f, props.cardName(f), needed(f, draft.core[f]), remindAt === f ? f : null),
        )}
        {asked(draft).map((f) =>
          row(
            `f-${f.key}`,
            props.fieldOf(f.key).label,
            f.required,
            remindAt === f.key ? f.key : null,
          ),
        )}
        {(['tags', 'notes'] as const)
          .filter((f) => draft.core[f].shown)
          .map((f) => row(f, props.cardName(f), needed(f, draft.core[f])))}
        <li>
          <span>Who can see it</span>
          <span className="muted">{visibilityWords(draft.visibility)}</span>
        </li>
      </ol>
      {remindAt === null && props.reminder && <p className="muted">{props.reminder}</p>}
      {draft.essential && <p className="muted">A new one is marked Essential.</p>}
    </section>
  );
}

const documentsHave = (n: number) => (n === 1 ? '1 document has' : `${n} documents have`);

/** One thing saving would do: `key` says which, whatever its words. */
interface Warning {
  key: string;
  text: string;
}

/**
 * What saving would do to the documents already filed, as far as the
 * reader can see them — and, whenever it would touch any, the sentence
 * saying there may be others they can't see (5.11). A field is named as
 * its documents show it now, as saved, so renaming it on this page does
 * not say a warning again at every letter (the 5.12 review).
 */
function warningsFor(
  kind: DocumentTypeView,
  draft: Draft,
  impact: DocumentTypeImpact,
  ctx: {
    /** The vault has reminders from any date (5.16b). */
    dated: boolean;
    wordFor: (f: CoreField) => string;
    fieldOf: (key: string) => { label: string };
    /** A date to remind from, as Reminders names it. */
    labelOf: (key: string) => string;
    /**
     * A date field as what is said of reminders names it: "Due date (your
     * own)" beside the built-in (the 5.16b review).
     */
    spoken: (key: string) => string;
    /** A date the kind reminds from as saved, in its words, named apart as `spoken`. */
    wasWord: (key: string) => string;
  },
): Warning[] {
  const { dated, wordFor, fieldOf } = ctx;
  const before = draftOf(kind, dated);
  const savedName = (f: CoreField) => tidy(before.core[f].label) ?? wordFor(f);
  // Reminders from any date: where they come from as saved, and now.
  const was = dated ? reminderOf(kind) : null;
  const now = dated && draft.reminding ? draft.from : null;
  // Reminders from a date they did not come from as saved: moved to it,
  // or switched on (the 5.16b review).
  const moved = was !== null && now !== null && now !== was.from ? now : null;
  const out: Warning[] = [];
  let touches = false;
  const needsInfo = (key: string, n: number, name: string) => {
    touches = true;
    if (n > 0) {
      out.push({
        key: `needs-${key}`,
        text: `${documentsHave(n)} nothing in “${name}” yet. ${n === 1 ? 'It' : 'They'}’ll show Needs info until someone fills it in.`,
      });
    }
  };
  const kept = (key: string, n: number, name: string, where: string) => {
    touches = true;
    if (n > 0) {
      out.push({
        key: `kept-${key}`,
        text: `${documentsHave(n)} something in “${name}”. It stays, ${where}; the card just stops asking for it.`,
      });
    }
  };

  for (const f of CORE_FIELDS) {
    const was = before.core[f];
    const now = draft.core[f];
    const counts = impact.core[f];
    // Reminders coming from Expires say how many have it, below.
    if (needed(f, now) && !needed(f, was) && !(f === 'expires' && moved === 'expires')) {
      needsInfo(f, counts.without_value, savedName(f));
    }
    if (was.shown && !now.shown) kept(f, counts.with_value, savedName(f), 'on each of them');
  }
  for (const f of asked(draft)) {
    const had = before.fields.find((x) => x.key === f.key);
    // Reminders moving to it say how many have it, below.
    if (f.required && !had?.required && f.key !== moved) {
      // The vault counts every field its documents keep a value for, the
      // kind's or not (a field it dropped, kept under Other details): one
      // it does not list, none of them has.
      const counts = impact.fields.find((x) => x.key === f.key);
      needsInfo(`f-${f.key}`, counts?.without_value ?? impact.documents, ctx.spoken(f.key));
    }
  }
  for (const f of before.fields) {
    if (!draft.fields.some((x) => x.key === f.key)) {
      const counts = impact.fields.find((x) => x.key === f.key);
      kept(`f-${f.key}`, counts?.with_value ?? 0, ctx.spoken(f.key), 'under Other details');
    }
  }
  const stop = (n: number, why: string) => {
    touches = true;
    if (n > 0) {
      out.push({
        key: 'reminders',
        text: `${n === 1 ? 'Its 1 reminder stops' : `Its ${n} reminders stop`}: ${why}.`,
      });
    }
  };
  const madeAgain = () => {
    touches = true;
    if (impact.documents > 0) {
      out.push({
        key: 'reminders',
        text: `The reminders for ${impact.documents === 1 ? 'its 1 document are' : `its ${impact.documents} documents are`} made again for the new times.`,
      });
    }
  };
  if (was) {
    // The reminders not dealt with yet about a date. A vault that does not
    // count them by date has them all about Expires.
    const about = (key: string) =>
      impact.reminders_by_source
        ? (impact.reminders_by_source[key] ?? 0)
        : key === 'expires'
          ? impact.reminders
          : 0;
    if (was.from !== null && now === null) {
      const r = about(was.from);
      if (asksForDate(draft, was.from)) stop(r, 'nobody is reminded about these documents');
      else if (was.from === 'expires') stop(r, 'its documents no longer expire');
      else stop(r, `it no longer asks for ${itsName(ctx.spoken(was.from))}`);
    } else if (moved !== null) {
      // Moved to another date, or switched on: how many are reminded from
      // it, and how many will say they need it.
      touches = true;
      const text = movedWords(
        impact,
        moved,
        ctx.labelOf(moved),
        fieldOf(moved).label,
        was.from === null ? null : { count: about(was.from), word: ctx.wasWord(was.from) },
      );
      if (text) out.push({ key: 'reminders', text });
    } else if (now !== null && now === was.from && !sameLeads(draft.leads, was.leads)) {
      madeAgain();
    }
  } else {
    const expired = before.core.expires.shown;
    if (expired && !draft.core.expires.shown)
      stop(impact.reminders, 'its documents no longer expire');
    else if (expired && !sameLeads(draft.leads, before.leads)) madeAgain();
  }
  if (touches) out.push({ key: 'unseen', text: impact.unseen });
  return out;
}

/**
 * Reminders moving to another date (5.16b), or switched on (`dropped`
 * null, the 5.16b review): how many of its documents have that date, and
 * are reminded from it; how many have none yet, and will say they need it;
 * and the reminders about the old date, not dealt with yet, that go. Null
 * when it has no documents to say it of.
 */
function movedWords(
  impact: DocumentTypeImpact,
  to: string,
  name: string,
  label: string,
  dropped: { count: number; word: string } | null,
): string | null {
  const n = impact.documents;
  if (n === 0) return null;
  const counts =
    to === 'expires'
      ? impact.core.expires
      : (impact.fields.find((f) => f.key === to) ?? { with_value: 0, without_value: n });
  const w = counts.with_value;
  const m = counts.without_value;
  const a = needsWords(to, to === 'expires' ? null : label);
  const docs = n === 1 ? 'its 1 document' : `its ${n} documents`;
  const until = `will read Needs ${a}, on Home too, until someone adds it`;
  const have = (k: number) => (k === 1 ? 'has' : 'have');
  const counted =
    m === 0
      ? `${n === 1 ? 'Its 1 document has' : `All ${n} of its documents have`} ${a} and ${n === 1 ? 'is' : 'are'} reminded from it.`
      : w === 0
        ? n === 1
          ? `Its 1 document has no ${a.replace(/^an? /, '')} yet: it ${until}.`
          : `None of its ${n} documents has ${a} yet: they ${until}.`
        : `Of ${docs}, ${w} ${have(w)} ${a} and ${w === 1 ? 'is' : 'are'} reminded from it; ${m} ${have(m)} none yet and ${until}.`;
  const gone =
    dropped && dropped.count > 0
      ? ` ${dropped.count} ${dropped.count === 1 ? 'reminder' : 'reminders'} from ${dropped.word} not dealt with yet ${dropped.count === 1 ? 'is' : 'are'} dropped.`
      : '';
  const lead = dropped ? `Its reminders move to ${name}.` : `Its reminders will come from ${name}.`;
  return `${lead} ${counted}${gone} Only reminders still to come are made.`;
}
