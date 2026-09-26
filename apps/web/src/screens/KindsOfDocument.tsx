import {
  can,
  CATEGORY_LABELS,
  categoryLabel,
  CORE_FIELDS,
  leadWords,
  refusalFor,
  reminderSentence,
  widensVisibility,
  type AttributeKind,
  type CoreField,
  type CoreFieldRule,
  type DocumentAttributeView,
  type DocumentTypeImpact,
  type DocumentTypeInput,
  type DocumentTypeView,
  type Visibility,
} from '@fdv/shared';
import { Children, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { coreRule } from '../details.js';
import {
  BottomNav,
  Button,
  ConfirmDialog,
  ErrorNote,
  Field,
  Select,
  Switch,
  TopBar,
} from '../ui.js';

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
  { id: 'visibility', name: 'Who can see', why: 'Who may open it.' },
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

const leadLabel = (days: number) => (days === 0 ? 'On the day' : leadWords(days));

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
        <TopBar title="Kinds of document" back="/settings" />
        <p className="status status-warn">{refusalFor('types.manage')}</p>
        <BottomNav />
      </main>
    );
  }

  const own = (data ?? []).filter((k) => k.builtin === false);
  const builtins = (data ?? []).filter((k) => k.builtin !== false);

  return (
    <main className="page page-top has-nav">
      <TopBar title="Kinds of document" back="/settings" />
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
      <BottomNav />
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

/** What the editor holds while somebody changes it: the kind as it will be saved. */
interface Draft {
  label: string;
  category: string;
  core: Record<CoreField, CoreFieldRule>;
  /** The details it asks for, from the library, in order. */
  fields: Array<{ key: string; required: boolean }>;
  leads: number[];
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

function draftOf(kind: DocumentTypeView | null): Draft {
  return {
    label: kind?.label ?? '',
    category: kind?.category ?? 'other',
    core: coreOf(kind),
    fields: (kind?.fields ?? []).map((f) => ({ key: f.key, required: f.required === true })),
    leads: kind?.reminder_leads ?? [],
    visibility: kind?.default_visibility ?? 'household',
    essential: kind?.usually_essential ?? false,
  };
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

/** A new kind, whole. */
function createBody(d: Draft): DocumentTypeInput {
  return {
    label: tidy(d.label) ?? '',
    category: d.category,
    core: Object.fromEntries(CORE_FIELDS.map((f) => [f, ruleOut(f, d.core[f])])),
    fields: d.fields.map((f) => ({ key: f.key, required: f.required })),
    ...(d.core.expires.shown ? { reminder_leads: d.leads } : {}),
    default_visibility: d.visibility,
    usually_essential: d.essential,
  };
}

/** A change to a kind: only what is different, so what somebody else changed meanwhile is theirs. */
function changeBody(kind: DocumentTypeView, d: Draft): DocumentTypeInput {
  const before = draftOf(kind);
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
  if (JSON.stringify(d.fields) !== JSON.stringify(before.fields)) {
    body.fields = d.fields.map((f) => ({ key: f.key, required: f.required }));
  }
  if (d.core.expires.shown && !sameLeads(d.leads, before.leads)) body.reminder_leads = d.leads;
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
  // A new start whenever the kind itself changes: after "Load the latest".
  return (
    <KindEditor
      key={kind?.etag ?? kind?.key ?? 'new'}
      kind={kind}
      library={data.library}
      onReload={() => void reload()}
    />
  );
}

function KindEditor(props: {
  kind: DocumentTypeView | null;
  library: DocumentAttributeView[];
  onReload: () => void;
}) {
  const { kind } = props;
  const { withToken, guarded } = useApp();
  const navigate = useNavigate();
  const role = storedRole();
  const mayWiden = can(role, 'types.widen_visibility');
  const builtin = kind !== null && kind.builtin !== false;
  const [draft, setDraft] = useState(() => draftOf(kind));
  const [library, setLibrary] = useState(props.library);
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
  const impact = useLoad(
    async (t) => (kind ? api.documentTypeImpact(t, kind.key) : null),
    [kind?.key, kind?.etag],
  );

  const review = kind?.expiry_driver === 'review_on';
  const wordFor = (f: CoreField) =>
    f === 'expires' && review ? 'Review by' : (OPTIONAL.find((o) => o.field === f)?.word ?? f);
  /** A fixed field's name on the card: the kind's, or the app's own word. */
  const cardName = (f: CoreField) => tidy(draft.core[f].label) ?? wordFor(f);
  const fieldOf = (key: string) => {
    const had = kind?.fields.find((f) => f.key === key);
    const lib = library.find((a) => a.key === key);
    return { key, label: had?.label ?? lib?.label ?? key, kind: had?.kind ?? lib?.kind ?? 'text' };
  };

  const setRule = (f: CoreField, change: Partial<CoreFieldRule>) =>
    setDraft((d) => {
      const rule = { ...d.core[f], ...change };
      // Hidden, it cannot be required.
      if (!rule.shown) rule.required = false;
      const leads = f === 'expires' && rule.shown && d.leads.length === 0 ? DEFAULT_LEADS : d.leads;
      return { ...d, core: { ...d.core, [f]: rule }, leads };
    });
  const setField = (key: string, shown: boolean, required: boolean) =>
    setDraft((d) => {
      const at = d.fields.findIndex((f) => f.key === key);
      if (!shown) return { ...d, fields: d.fields.filter((f) => f.key !== key) };
      if (at < 0) return { ...d, fields: [...d.fields, { key, required }] };
      return { ...d, fields: d.fields.map((f) => (f.key === key ? { key, required } : f)) };
    });

  const save = async () => {
    const label = tidy(draft.label);
    if (!builtin && !label) {
      setError('Give the kind of document a name.');
      return;
    }
    const body = kind ? changeBody(kind, draft) : createBody(draft);
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
  const saved = kind?.default_visibility;
  const narrowOnly = saved !== undefined && !mayWiden;
  const warnings =
    kind && impact.data ? warningsFor(kind, draft, impact.data, cardName, fieldOf) : [];

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
            onChange={(label) => setDraft((d) => ({ ...d, label }))}
            required={false}
            placeholder="Allotment tenancy"
          />
          <Select
            id="k-category"
            label="Category"
            value={draft.category}
            onChange={(category) => setDraft((d) => ({ ...d, category }))}
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
              {field === 'expires' && (
                <>
                  <p className="muted">A document of a kind that expires always needs the date.</p>
                  <LeadChips
                    leads={draft.leads}
                    when={review ? 'it’s due for review' : 'it expires'}
                    onChange={(leads) => setDraft((d) => ({ ...d, leads }))}
                  />
                  <p className="muted">
                    {reminder ?? 'No reminders: nobody is told before the day.'}
                  </p>
                </>
              )}
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
                name={f.label}
                what={KIND_WORDS[f.kind]}
                shown={shownKeys.has(key)}
                required={mine?.required ?? false}
                requiredOffered
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
          onAdded={(a) => {
            setLibrary((l) => [...l, a]);
            setOrder((o) => {
              const at = o.findIndex((k) => !shownKeys.has(k));
              return at < 0 ? [...o, a.key] : [...o.slice(0, at), a.key, ...o.slice(at)];
            });
            setField(a.key, true, false);
            setAdded(`“${a.label}” is on the card now, and in the library for every kind.`);
          }}
        />
      </section>

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
                  onClick={() => setDraft((d) => ({ ...d, visibility: v }))}
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
          {draft.visibility === 'private' && (
            <span className="muted">
              Only the person it belongs to can open one. Filing one for somebody else asks who can
              see it.
            </span>
          )}
        </div>
        <div className="check">
          <input
            id="k-essential"
            type="checkbox"
            checked={draft.essential}
            onChange={(e) => setDraft((d) => ({ ...d, essential: e.target.checked }))}
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
        reminder={expires.shown ? reminder : null}
      />

      <div className="kind-warnings" aria-live="polite">
        {warnings.length > 0 && (
          <>
            <p className="field-label">Before you save</p>
            <ul>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
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
  onShown?: (shown: boolean) => void;
  onRequired?: (required: boolean) => void;
  children?: ReactNode;
}) {
  const shown = props.locked === true || props.shown === true;
  const note = props.why ?? props.what;
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
                checked={props.required === true}
                onChange={(e) => props.onRequired?.(e.target.checked)}
              />
              <label htmlFor={`${props.id}-required`}>Required</label>
            </div>
          )}
        </div>
        {!props.locked && shown && Children.toArray(props.children).length > 0 && (
          <div className="kind-field-more stack">{props.children}</div>
        )}
      </div>
    </li>
  );
}

/** When to remind, before it expires: chips, at most eight on. */
function LeadChips(props: { leads: number[]; when: string; onChange: (leads: number[]) => void }) {
  const offered = [...new Set([...LEAD_CHOICES, ...props.leads])].sort((a, b) => a - b);
  const full = props.leads.length >= MAX_LEADS;
  return (
    <div className="field" role="group" aria-labelledby="k-leads-l">
      <span id="k-leads-l" className="field-label">
        Remind us before {props.when}
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

/** A field of the household's own, for the library, shown on this kind at once. */
function AddOwnField(props: { onAdded: (a: DocumentAttributeView) => void }) {
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
        <ErrorNote message={error} />
        <Button type="submit" kind="quiet" disabled={busy}>
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
}) {
  const { draft } = props;
  const row = (key: string, name: string, required: boolean) => (
    <li key={key}>
      <span>{name}</span>
      {required && (
        <span className="muted">
          <span aria-hidden="true">* </span>required
        </span>
      )}
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
          row(f, props.cardName(f), needed(f, draft.core[f])),
        )}
        {draft.fields.map((f) => row(`f-${f.key}`, props.fieldOf(f.key).label, f.required))}
        {(['tags', 'notes'] as const)
          .filter((f) => draft.core[f].shown)
          .map((f) => row(f, props.cardName(f), needed(f, draft.core[f])))}
        <li>
          <span>Who can see this</span>
          <span className="muted">{visibilityWords(draft.visibility)}</span>
        </li>
      </ol>
      {props.reminder && <p className="muted">{props.reminder}</p>}
      {draft.essential && <p className="muted">A new one is marked Essential.</p>}
    </section>
  );
}

const documentsHave = (n: number) => (n === 1 ? '1 document has' : `${n} documents have`);

/**
 * What saving would do to the documents already filed, as far as the
 * reader can see them — and, whenever it would touch any, the sentence
 * saying there may be others they can't see (5.11).
 */
function warningsFor(
  kind: DocumentTypeView,
  draft: Draft,
  impact: DocumentTypeImpact,
  cardName: (f: CoreField) => string,
  fieldOf: (key: string) => { label: string },
): string[] {
  const before = draftOf(kind);
  const out: string[] = [];
  let touches = false;
  const needsInfo = (n: number, name: string) => {
    touches = true;
    if (n > 0) {
      out.push(
        `${documentsHave(n)} nothing in “${name}” yet. ${n === 1 ? 'It' : 'They'}’ll show Needs info until someone fills it in.`,
      );
    }
  };
  const kept = (n: number, name: string, where: string) => {
    touches = true;
    if (n > 0) {
      out.push(
        `${documentsHave(n)} something in “${name}”. It stays, ${where}; the card just stops asking for it.`,
      );
    }
  };

  for (const f of CORE_FIELDS) {
    const was = before.core[f];
    const now = draft.core[f];
    const counts = impact.core[f];
    if (needed(f, now) && !needed(f, was)) needsInfo(counts.without_value, cardName(f));
    if (was.shown && !now.shown) kept(counts.with_value, cardName(f), 'on each of them');
  }
  for (const f of draft.fields) {
    const had = before.fields.find((x) => x.key === f.key);
    if (f.required && !had?.required) {
      const counts = impact.fields.find((x) => x.key === f.key);
      needsInfo(counts?.without_value ?? impact.documents, fieldOf(f.key).label);
    }
  }
  for (const f of before.fields) {
    if (!draft.fields.some((x) => x.key === f.key)) {
      const counts = impact.fields.find((x) => x.key === f.key);
      kept(counts?.with_value ?? 0, fieldOf(f.key).label, 'under Other details');
    }
  }
  const expired = before.core.expires.shown;
  if (expired && !draft.core.expires.shown) {
    touches = true;
    if (impact.reminders > 0) {
      out.push(
        `${impact.reminders === 1 ? 'Its 1 reminder stops' : `Its ${impact.reminders} reminders stop`}: its documents no longer expire.`,
      );
    }
  } else if (expired && !sameLeads(draft.leads, before.leads)) {
    touches = true;
    if (impact.documents > 0) {
      out.push(
        `The reminders for ${impact.documents === 1 ? 'its 1 document are' : `its ${impact.documents} documents are`} made again for the new times.`,
      );
    }
  }
  if (touches) out.push(impact.unseen);
  return out;
}
