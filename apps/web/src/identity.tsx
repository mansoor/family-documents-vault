import {
  formatDate,
  IDENTITY_FIELDS,
  IDENTITY_ID_KINDS,
  IDENTITY_ID_LABELS,
  IDENTITY_LISTS,
  IDENTITY_SEXES,
  IDENTITY_TEXT_FIELDS,
  identityChanges,
  shareEndWords,
  type DocumentTypeView,
  type DocumentView,
  type IdentityAudience,
  type IdentityFields,
  type IdentityIdKind,
  type IdentityList,
  type IdentityPart,
  type IdentityPartView,
  type IdentityView,
} from '@fdv/shared';
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { api, ApiRequestError, type Member } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { storedRole } from './session.js';
import { Button, ErrorNote, Field, Select, Switch, TextArea } from './ui.js';

/**
 * A person's identity details on the web (5.27), over 5.26's API: the card
 * on their profile, its form, and the notice of a wider audience waiting.
 *
 * What the vault keeps masked — every ID's number, every hidden field's
 * value — comes without its value (`masked` names it). It is shown only
 * when asked for, which asks who is asking and is a line in the activity
 * log; copying it asks the same, and is the same line. The form sends a
 * masked value only when it was typed anew or cleared on purpose: left out,
 * the vault keeps what it has.
 *
 * Only me: what the person marks so is theirs alone. No one in the family
 * can open it; whoever runs the server holds the master key, and could. The
 * form says so under every switch that is on.
 */

/** Said under an Only me switch that is on (5.27, the honest limit). */
export const ONLY_ME_LIMIT =
  'No one in the family can open these. Whoever runs your vault’s server could.';

/** Said where two-step sign-in is what is missing, with the way to it. */
const TWO_STEP_CODES = new Set(['two_step_required', 'totp_required_for_owner']);

const SECTIONS: Array<{ key: (typeof IDENTITY_FIELDS)[number]['section']; title: string }> = [
  { key: 'name', title: 'Name' },
  { key: 'birth', title: 'Birth and nationality' },
  { key: 'contact', title: 'Contact' },
  { key: 'work', title: 'Work' },
  { key: 'ids', title: 'Government IDs' },
  { key: 'other', title: 'Other details' },
];

const PARTS: IdentityPart[] = ['shared', 'only_me'];

/** "United Kingdom" for GB; the code itself where the browser has no name for it. */
export function countryName(code: string): string {
  try {
    const names = new Intl.DisplayNames(['en-GB'], { type: 'region' });
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

const SEX_WORDS: Record<string, string> = { F: 'F (female)', M: 'M (male)', X: 'X' };

/** A day in words: "31 March 2031". */
function dayWords(day: string): string {
  return formatDate({ date: day, precision: 'day' });
}

/** What an ID's number is called, in a sentence: "passport number", "NHS number". */
function idNumberLabel(e: { kind: IdentityIdKind; label?: string | null }): string {
  const named = e.label?.trim();
  if (named) return /number$/i.test(named) ? named : `${named} number`;
  const kind = IDENTITY_ID_LABELS[e.kind] ?? 'ID';
  const word = kind.charAt(0).toLowerCase() + kind.slice(1);
  return /number$/.test(word) ? word : `${word} number`;
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What tells two IDs apart that would be called the same — two passports
 * with no name of their own, a dual national's (the 5.27 review): who issued
 * each, where that differs, or else a number. By key; '' where one is alone.
 */
export function idSuffixes(
  ids: ReadonlyArray<{
    key: string;
    kind: string;
    label?: string | null | undefined;
    issuer?: string | null | undefined;
  }>,
): Map<string, string> {
  const groups = new Map<string, typeof ids>();
  for (const i of ids) {
    const name = `${i.kind}|${(i.label ?? '').trim().toLowerCase()}`;
    groups.set(name, [...(groups.get(name) ?? []), i]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    const issuers = group.map((i) => (i.issuer ?? '').trim());
    const byIssuer =
      issuers.every(Boolean) && new Set(issuers.map((x) => x.toLowerCase())).size === group.length;
    group.forEach((i, n) => {
      out.set(
        i.key,
        group.length < 2 ? '' : byIssuer ? `, issued by ${issuers[n] as string}` : ` ${n + 1}`,
      );
    });
  }
  return out;
}

/**
 * Whether this browser can copy at all: the Clipboard API is there only on
 * a secure connection, so a vault reached over plain http on the home
 * network has none. Without it Copy is not offered, and nothing is revealed
 * for a copy that cannot happen (the 5.27 review).
 */
export function canCopy(): boolean {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  return typeof window === 'undefined' || window.isSecureContext !== false;
}

/**
 * Who sees a person's shared details, in a sentence (A34): the person (when
 * they sign in), the owners, and whoever the household's audience adds.
 */
export function seenByWords(
  audience: IdentityAudience,
  person: { self: boolean; name: string; signsIn: boolean },
): string {
  const them = person.self ? 'you' : person.signsIn ? person.name : null;
  switch (audience) {
    case 'adults':
      return them
        ? `Seen by ${them}, the owners and all adults.`
        : 'Seen by the owners and all adults.';
    case 'family':
      return them
        ? `Seen by ${them} and everyone in the family but viewers.`
        : 'Seen by everyone in the family but viewers.';
    default:
      return them ? `Seen by ${them} and the owners.` : 'Seen by the owners.';
  }
}

// ------------------------------------------------------------ copying

/**
 * Copies what a reveal gives. Where the browser takes a promise of what to
 * copy (Safari asks for it inside the press itself), the reveal is that
 * promise; elsewhere it is copied once it comes. False when nothing was
 * shown, or the browser would not copy it.
 */
export async function copyRevealed(text: Promise<string | null>): Promise<boolean> {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clip) {
    await text;
    return false;
  }
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (Item && typeof clip.write === 'function') {
    try {
      const blob = text.then((t) => {
        if (t === null) throw new Error('nothing shown');
        return new Blob([t], { type: 'text/plain' });
      });
      await clip.write([new Item({ 'text/plain': blob })]);
      return true;
    } catch {
      // Not shown, or not taken that way: tried once more as text below.
    }
  }
  const t = await text;
  if (t === null) return false;
  try {
    await clip.writeText(t);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ the card

/**
 * The Identity card on a person's profile (5.27): their details in
 * sections, masked numbers with Show and Copy, and "Edit identity details"
 * for whoever may change them. Somebody not given the record (404) sees no
 * card at all, as they see no record.
 */
export function IdentityCard(props: {
  member: Member;
  /** What the screen calls them. */
  name: string;
  types?: DocumentTypeView[] | undefined;
  /** Opened from "Add their details now": straight into the form. */
  startEditing?: boolean;
}) {
  const { member } = props;
  const { caps, authVersion, guarded } = useApp();
  const location = useLocation();
  const offered = caps?.features.member_identity === true;
  const { data, error, setData, reload } = useLoad(
    async (t) => {
      if (!offered) return null;
      try {
        return await api.identity(t, member.id);
      } catch (err) {
        // Not given it: no card, as there is no record for them.
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      }
    },
    [member.id, authVersion, offered],
  );
  const view = data ?? null;
  const [editingNow, setEditing] = useState(false);
  // "Add their details now" opens the form once; closing it closes it.
  const [startUsed, setStartUsed] = useState(false);
  const mayEdit = view ? view.can_edit.shared || view.can_edit.only_me : false;
  const editing = editingNow || (props.startEditing === true && !startUsed && mayEdit);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [twoStep, setTwoStep] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const problemAt = useRef<HTMLParagraphElement>(null);
  const values = useRef(new Map<string, HTMLElement>());
  // A problem said after the card was read again: heard, once it is there.
  const [problemHeard, setProblemHeard] = useState(0);
  useEffect(() => {
    if (problemHeard > 0) problemAt.current?.focus();
  }, [problemHeard]);
  // Linked to (the notice of a wider audience, 5.27): once the card is
  // there to go to, it is scrolled to and its heading takes the focus.
  const arrived = useRef(false);
  const loaded = view !== null;
  useEffect(() => {
    if (!loaded || arrived.current || location.hash !== '#identity') return;
    arrived.current = true;
    heading.current?.scrollIntoView?.();
    heading.current?.focus();
  }, [loaded, location.hash]);

  if (!offered || !view) {
    return error ? (
      <section className="card stack" aria-labelledby="identity-h" id="identity">
        <h2 id="identity-h" style={{ fontSize: 18 }}>
          Identity details
        </h2>
        <ErrorNote message={error} />
      </section>
    ) : null;
  }

  /**
   * Masked values of a part, by key, once whoever asks has said who they
   * are; null when they did not, or may not.
   */
  const reveal = async (
    part: IdentityPart,
    keys: string[],
  ): Promise<Record<string, string> | null> => {
    setProblem(null);
    setTwoStep(null);
    try {
      const got = await guarded((t) =>
        api.revealIdentity(t, member.id, part === 'only_me' ? { part, keys } : { keys }),
      );
      return got?.values ?? null;
    } catch (err) {
      if (err instanceof ApiRequestError && TWO_STEP_CODES.has(err.code)) setTwoStep(err.message);
      else setProblem(describeError(err));
      return null;
    }
  };

  const show = async (part: IdentityPart, key: string, label: string) => {
    if (busy) return;
    setBusy(`${part}:${key}`);
    setSaid(null);
    try {
      const got = await reveal(part, [key]);
      if (!got) return;
      const value = got[key];
      if (value === undefined) {
        await gone(label);
        return;
      }
      flushSync(() => setShown((s) => ({ ...s, [`${part}:${key}`]: value })));
      // The number itself, so it is heard as soon as it is there.
      values.current.get(`${part}:${key}`)?.focus();
    } finally {
      setBusy(null);
    }
  };

  const hide = (part: IdentityPart, key: string) => {
    setShown((s) => {
      const next = { ...s };
      delete next[`${part}:${key}`];
      return next;
    });
  };

  /**
   * A value the vault no longer has — cleared elsewhere since the card was
   * read: said, the card read again, and the focus on what was said, since
   * the button pressed goes with it.
   */
  const gone = async (label: string) => {
    setProblem(`There is no ${label} to show any more.`);
    await reload();
    setProblemHeard((n) => n + 1);
  };

  const copy = async (part: IdentityPart, key: string, label: string) => {
    if (busy) return;
    setBusy(`${part}:${key}`);
    setSaid(null);
    try {
      // Copying shows it as surely as Show does: asked, and logged, the same.
      let missing = false;
      const asked = reveal(part, [key]).then((v) => {
        missing = v !== null && v[key] === undefined;
        return v?.[key] ?? null;
      });
      const copied = await copyRevealed(asked);
      if (copied) setSaid(`${capitalised(label)} copied.`);
      else if (missing) await gone(label);
      else if ((await asked) !== null) {
        setProblem('This browser would not copy it. Show it instead, and copy it from there.');
      }
    } finally {
      setBusy(null);
    }
  };
  const copyOffered = canCopy();

  const closeForm = () => {
    setEditing(false);
    setStartUsed(true);
  };

  const self = member.is_me;
  const empty =
    view.shared.filled.length === 0 && (view.only_me ? view.only_me.filled.length === 0 : true);
  // Two IDs called the same are told apart (the 5.27 review).
  const suffixes = idSuffixes(
    PARTS.flatMap((part) =>
      ((part === 'shared' ? view.shared : view.only_me)?.fields.ids ?? []).map((i) => ({
        key: `${part}:${i.id}`,
        kind: i.kind,
        label: i.label,
        issuer: i.issuer,
      })),
    ),
  );
  const sections = SECTIONS.map((s) => ({
    ...s,
    rows: PARTS.flatMap((part) => {
      const pv = part === 'shared' ? view.shared : view.only_me;
      return pv ? rowsOf(pv, part, s.key, suffixes) : [];
    }).sort((a, b) => a.order - b.order),
  })).filter((s) => s.rows.length > 0);

  const secret = (r: Row) => {
    const at = `${r.part}:${r.key}`;
    const value = shown[at];
    return (
      <span className="identity-secret">
        <span
          className="identity-secret-value"
          tabIndex={-1}
          ref={(el) => {
            if (el) values.current.set(at, el);
            else values.current.delete(at);
          }}
        >
          {value !== undefined ? (
            <>
              <span className="visually-hidden">{capitalised(r.secretLabel ?? '')}: </span>
              {value}
            </>
          ) : (
            <>
              <span aria-hidden="true">••••••••</span>
              <span className="visually-hidden">{capitalised(r.secretLabel ?? '')}, hidden</span>
            </>
          )}
        </span>
        <span className="row identity-secret-actions">
          {/* One button, Show or Hide: pressed, it keeps the focus it has. */}
          <button
            type="button"
            className="btn btn-quiet btn-small"
            aria-label={`${value !== undefined ? 'Hide' : 'Show'} ${r.secretLabel ?? ''}`}
            aria-disabled={value === undefined && busy !== null}
            onClick={() =>
              value !== undefined
                ? hide(r.part, r.key)
                : void show(r.part, r.key, r.secretLabel ?? '')
            }
          >
            {value !== undefined ? 'Hide' : 'Show'}
          </button>
          {copyOffered && (
            <button
              type="button"
              className="btn btn-quiet btn-small"
              aria-label={`Copy ${r.secretLabel ?? ''}`}
              aria-disabled={busy !== null}
              onClick={() => void copy(r.part, r.key, r.secretLabel ?? '')}
            >
              Copy
            </button>
          )}
        </span>
      </span>
    );
  };

  return (
    <section className="card stack" aria-labelledby="identity-h" id="identity">
      <div className="card-head">
        <h2 id="identity-h" style={{ fontSize: 18 }} ref={heading} tabIndex={-1}>
          Identity details
        </h2>
        {mayEdit && !editing && (
          <button
            ref={editButton}
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setSaid(null);
              setEditing(true);
            }}
          >
            {empty ? 'Add identity details' : 'Edit identity details'}
          </button>
        )}
      </div>
      <p className="muted">
        {seenByWords(view.audience, {
          self,
          name: props.name,
          signsIn: member.has_account,
        })}
        {view.can_edit.only_me ? ' What you mark Only me is yours alone.' : ''}
      </p>
      {editing ? (
        <IdentityForm
          view={view}
          member={member}
          name={props.name}
          types={props.types}
          reveal={reveal}
          onSaved={(saved) => {
            flushSync(() => {
              setData(saved);
              setShown({});
              closeForm();
              setSaid('Identity details saved.');
            });
            editButton.current?.focus();
          }}
          onStale={(fresh) => setData(fresh)}
          onCancel={(wrote) => {
            flushSync(closeForm);
            editButton.current?.focus();
            // A part saved on the way: the card shows what the vault has.
            if (wrote) void reload();
          }}
        />
      ) : empty ? (
        <p className="muted">
          {self ? 'Nothing kept here yet.' : `Nothing kept here for ${props.name} yet.`}
          {!mayEdit && self ? ' An owner can add your details.' : ''}
        </p>
      ) : (
        sections.map((s) => (
          <div key={s.key} className="identity-section">
            <h3 className="identity-h3">{s.title}</h3>
            <dl className="facts">
              {s.rows.map((r) => (
                <Fragment key={`${r.part}:${r.key}`}>
                  <dt>
                    {r.label}
                    {r.part === 'only_me' && (
                      <span className="badge identity-only-me">Only me</span>
                    )}
                  </dt>
                  <dd>
                    {r.secretLabel ? (
                      r.value === null ? (
                        secret(r)
                      ) : (
                        <span>{r.value}</span>
                      )
                    ) : (
                      <span className={r.multiline ? 'keep-lines' : undefined}>{r.value}</span>
                    )}
                    {r.more.length > 0 && (
                      <span className="identity-more muted">
                        {r.more.map((m, i) => (
                          <span key={i}>{m}</span>
                        ))}
                      </span>
                    )}
                    {r.documentId && (
                      <Link to={`/documents/${r.documentId}`} className="quiet-link">
                        Open the document
                      </Link>
                    )}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ))
      )}
      {/* A reveal's refusal, from the card or the form's Show. */}
      {twoStep && <TwoStepNeeded message={twoStep} />}
      {problem && (
        <p ref={problemAt} className="error" role="alert" tabIndex={-1}>
          {problem}
        </p>
      )}
      <p ref={status} className="notice status-line" role="status">
        {said}
      </p>
    </section>
  );
}

/** Two-step sign-in is what is missing: said, with the way to it (as 5.25's account card). */
export function TwoStepNeeded(props: { message: string }) {
  return (
    <div className="stack">
      <p className="status status-warn" role="alert" tabIndex={-1}>
        {props.message}
      </p>
      <Link to="/settings/account#two-step" className="btn btn-quiet">
        Set up two-step sign-in
      </Link>
    </div>
  );
}

interface Row {
  key: string;
  part: IdentityPart;
  label: string;
  /** Null for a masked value not shown. */
  value: ReactNode;
  /** What a masked value is called ("passport number"); set only for one masked. */
  secretLabel?: string;
  more: string[];
  documentId?: string | null | undefined;
  multiline?: boolean;
  order: number;
}

/** A part's rows for one section, in the catalogue's order. */
function rowsOf(
  pv: IdentityPartView,
  part: IdentityPart,
  section: string,
  suffixes: Map<string, string>,
): Row[] {
  const f = pv.fields;
  const masked = new Set(pv.masked);
  const rows: Row[] = [];
  IDENTITY_FIELDS.forEach((field, i) => {
    if (field.section !== section) return;
    const order = i * 2 + (part === 'only_me' ? 1 : 0);
    const key = field.key;
    if (key === 'nationalities') {
      if (f.nationalities?.length) {
        rows.push({
          key,
          part,
          label: field.label,
          value: f.nationalities.map(countryName).join(', '),
          more: [],
          order,
        });
      }
      return;
    }
    if ((IDENTITY_LISTS as readonly string[]).includes(key)) {
      const list = key as IdentityList;
      for (const e of (f[list] ?? []) as unknown as Array<Record<string, unknown>>) {
        const row = entryRow(
          list,
          e,
          masked.has(`${list}.${String(e.id)}`),
          suffixes.get(`${part}:${String(e.id)}`) ?? '',
        );
        if (row) rows.push({ ...row, part, order });
      }
      return;
    }
    const v = f[key as (typeof IDENTITY_TEXT_FIELDS)[number]];
    if (typeof v !== 'string' || v.trim() === '') return;
    rows.push({
      key,
      part,
      label: field.label,
      value: key === 'country_of_birth' ? countryName(v) : key === 'sex' ? (SEX_WORDS[v] ?? v) : v,
      more: [],
      multiline: key === 'notes',
      order,
    });
  });
  return rows;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "Home email", "Work phone", "Address": what it is, with what it is for. */
export function contactLabel(label: string, noun: 'email' | 'phone' | 'address'): string {
  if (!label) return capitalised(noun);
  return label.toLowerCase().includes(noun) ? label : `${label} ${noun}`;
}

/** One entry of a list, as a row; null when it holds nothing to show. */
function entryRow(
  list: IdentityList,
  e: Record<string, unknown>,
  isMasked: boolean,
  /** What tells this ID from another called the same (idSuffixes). */
  suffix = '',
): Omit<Row, 'part' | 'order'> | null {
  const key = `${list}.${String(e.id)}`;
  switch (list) {
    case 'emails':
    case 'phones': {
      if (!text(e.value)) return null;
      return {
        key,
        label: contactLabel(text(e.label), list === 'emails' ? 'email' : 'phone'),
        value: text(e.value),
        more: [],
      };
    }
    case 'addresses': {
      const lines = [
        text(e.line1),
        text(e.line2),
        text(e.line3),
        [text(e.city), text(e.region), text(e.postal_code)].filter(Boolean).join(', '),
        text(e.country) ? countryName(text(e.country)) : '',
      ].filter(Boolean);
      if (lines.length === 0) return null;
      return {
        key,
        label: contactLabel(text(e.label), 'address'),
        value: lines.join('\n'),
        more: [],
        multiline: true,
      };
    }
    case 'ids': {
      const kind = (e.kind as IdentityIdKind) ?? 'other';
      const more = [
        text(e.issuer) ? `Issued by ${text(e.issuer)}` : '',
        text(e.issued_on) ? `Issued ${dayWords(text(e.issued_on))}` : '',
        text(e.expires_on) ? `Expires ${dayWords(text(e.expires_on))}` : '',
      ].filter(Boolean);
      const number = text(e.number);
      if (!isMasked && !number && more.length === 0 && typeof e.document_id !== 'string') {
        return null;
      }
      const named = text(e.label);
      return {
        key,
        label:
          (named ? `${IDENTITY_ID_LABELS[kind] ?? 'ID'}: ${named}` : IDENTITY_ID_LABELS[kind]) +
          suffix,
        value: isMasked ? null : number || 'No number kept',
        ...(isMasked
          ? { secretLabel: idNumberLabel({ kind, label: named || null }) + suffix }
          : {}),
        more,
        documentId: typeof e.document_id === 'string' ? e.document_id : null,
      };
    }
    case 'custom': {
      if (!isMasked && !text(e.value)) return null;
      return {
        key,
        label: text(e.label) || 'Detail',
        value: isMasked ? null : text(e.value),
        ...(isMasked ? { secretLabel: text(e.label) || 'detail' } : {}),
        more: [],
        multiline: !isMasked,
      };
    }
  }
}

// ------------------------------------------------------------ the form

type TextKey = (typeof IDENTITY_TEXT_FIELDS)[number] | 'nationalities';

const TEXT_KEYS: TextKey[] = [...IDENTITY_TEXT_FIELDS, 'nationalities'];

interface DraftText {
  uid: string;
  key: TextKey;
  value: string;
  onlyMe: boolean;
  from: IdentityPart | null;
}

interface DraftEntry {
  uid: string;
  list: IdentityList;
  id: string;
  onlyMe: boolean;
  /** The part it was read from; null for one added here. */
  from: IdentityPart | null;
  /** Its fields, as typed. */
  f: Record<string, string>;
  /** A field of the family's own, hidden until shown. */
  hidden: boolean;
  /** Its document: undefined when not shown to this editor (kept as it is). */
  documentId: string | null | undefined;
  /** The document it had when read. */
  linkedBefore: string | null | undefined;
  /** Its number (an ID's) or value (a hidden field's) came masked. */
  masked: boolean;
  /** What a reveal showed of it; null until then. */
  known: string | null;
  /**
   * The value a reveal showed was put in the field, for the editor to see:
   * cleared after that, it is cleared on purpose. Never put there (some
   * text was typed over it first), an empty field keeps it.
   */
  shownInField: boolean;
}

interface Draft {
  texts: DraftText[];
  entries: DraftEntry[];
}

let uids = 0;
const nextUid = () => `i${(uids += 1)}`;

/** An entry id the vault takes: letters and digits, unique enough in its list. */
const newEntryId = () =>
  `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);

/** The field of a list entry that can be masked: an ID's number, a hidden field's value. */
const secretOf = (list: IdentityList): 'number' | 'value' | null =>
  list === 'ids' ? 'number' : list === 'custom' ? 'value' : null;

function entryFrom(
  list: IdentityList,
  e: Record<string, unknown>,
  part: IdentityPart,
  masked: readonly string[],
): DraftEntry {
  const f: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'id' || k === 'hidden' || k === 'document_id') continue;
    if (typeof v === 'string') f[k] = v;
  }
  const linked =
    'document_id' in e ? (typeof e.document_id === 'string' ? e.document_id : null) : undefined;
  return {
    uid: nextUid(),
    list,
    id: String(e.id),
    onlyMe: part === 'only_me',
    from: part,
    f,
    hidden: e.hidden === true,
    documentId: linked,
    linkedBefore: linked,
    masked: masked.includes(`${list}.${String(e.id)}`),
    known: null,
    shownInField: false,
  };
}

/** The form's draft of a record as the editor was shown it. */
export function draftFrom(view: IdentityView): Draft {
  const texts: DraftText[] = [];
  const entries: DraftEntry[] = [];
  for (const part of PARTS) {
    const pv = part === 'shared' ? view.shared : view.only_me;
    if (!pv) continue;
    const f = pv.fields;
    for (const key of IDENTITY_TEXT_FIELDS) {
      const v = f[key];
      if (typeof v === 'string' && v.trim() !== '') {
        texts.push({ uid: nextUid(), key, value: v, onlyMe: part === 'only_me', from: part });
      }
    }
    if (f.nationalities?.length) {
      texts.push({
        uid: nextUid(),
        key: 'nationalities',
        value: f.nationalities.join(', '),
        onlyMe: part === 'only_me',
        from: part,
      });
    }
    for (const list of IDENTITY_LISTS) {
      for (const e of (f[list] ?? []) as unknown as Array<Record<string, unknown>>) {
        entries.push(entryFrom(list, e, part, pv.masked));
      }
    }
  }
  // A field for each they have none of yet, in the shared part.
  for (const key of TEXT_KEYS) {
    if (!texts.some((t) => t.key === key)) {
      texts.push({ uid: nextUid(), key, value: '', onlyMe: false, from: null });
    }
  }
  return { texts, entries };
}

/** Country codes typed as "GB, pk": GB and PK. */
const codes = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

/** What the edit leaves of the fields one value each: blank is none. */
function entryOut(e: DraftEntry, part: IdentityPart): Record<string, unknown> | null {
  const secret = secretOf(e.list);
  const moved = e.from !== null && e.from !== part;
  const out: Record<string, unknown> = { id: e.id };
  for (const [k, v] of Object.entries(e.f)) {
    if (k === secret && e.masked) continue;
    const t = v.trim();
    if (t !== '') out[k] = k === 'country' ? t.toUpperCase() : t;
  }
  if (e.list === 'custom' && e.hidden) out.hidden = true;
  if (secret && e.masked) {
    const typed = (e.f[secret] ?? '').trim();
    // Moved to the other part, or a hidden field unhidden: sent whole, since
    // the vault keeps a value left out where it was, and hidden
    // (mergeIdentityWrite). Moving and unhiding show it first (the form).
    const whole = moved || (e.list === 'custom' && !e.hidden);
    if (typed) {
      // Typed anew; shown and left as it was, it is no change.
      if (whole || e.known === null || typed !== e.known.trim()) out[secret] = typed;
    } else if (e.shownInField) {
      // Shown in the field, and cleared on purpose.
      out[secret] = null;
    } else if (whole && e.known !== null) {
      // Never shown there, nor typed over: it goes with the entry as it is.
      out[secret] = e.known;
    }
    // Otherwise left out: the vault keeps what it has.
  }
  if (typeof e.documentId === 'string') out.document_id = e.documentId;
  else if (e.documentId === null && typeof e.linkedBefore === 'string' && !moved) {
    out.document_id = null;
  }
  // A row added here and left blank is left out. An email, a phone or an
  // address emptied is removed, as Remove removes it: nothing of one is ever
  // masked or kept from the editor, so empty is all there is (the 5.27
  // review). An ID or a field of the family's own read from the vault stays
  // unless Remove takes it away, whatever this editor can see of it: a link
  // to a document they may not see may be all it has.
  const skip = e.list === 'ids' ? ['id', 'kind', 'label'] : ['id', 'label', 'hidden'];
  const holds = Object.entries(out).some(([k, v]) => !skip.includes(k) && v !== null);
  const contact = e.list === 'emails' || e.list === 'phones' || e.list === 'addresses';
  const keeps = holds || (!contact && e.from !== null);
  if (!keeps) return null;
  if (e.list === 'ids' && !out.kind) out.kind = 'other';
  if (e.list === 'custom' && !out.label) out.label = 'Detail';
  return out;
}

/** Which part an item is in, as the form has it now. */
const partOf = (x: { onlyMe: boolean }): IdentityPart => (x.onlyMe ? 'only_me' : 'shared');

/**
 * Entries moved to the other part whose masked value was never shown, nor
 * typed over: saved, the value would be lost, since the part it moves to
 * has no copy to keep (the 5.27 review). Moving one shows it first; this is
 * what the form checks before it saves, in case anything ever does not.
 */
export function movedUnshown(d: Draft): DraftEntry[] {
  return d.entries.filter(
    (e) =>
      e.masked &&
      e.known === null &&
      e.from !== null &&
      e.from !== partOf(e) &&
      !(e.f[secretOf(e.list) ?? ''] ?? '').trim(),
  );
}

/** One part, as the form would send it. */
export function buildPart(d: Draft, part: IdentityPart): IdentityFields {
  const out: Record<string, unknown> = {};
  const here = (onlyMe: boolean) => (part === 'only_me') === onlyMe;
  for (const t of d.texts) {
    if (!here(t.onlyMe) || t.value.trim() === '') continue;
    if (t.key === 'nationalities') out.nationalities = codes(t.value);
    else if (t.key === 'country_of_birth') out.country_of_birth = t.value.trim().toUpperCase();
    else out[t.key] = t.value.trim();
  }
  for (const list of IDENTITY_LISTS) {
    const entries = d.entries.filter((e) => e.list === list && here(e.onlyMe));
    // One id twice — an entry a partial save left in both parts, moved back
    // (the 5.27 review): the one moved in takes the place of the one there,
    // with what was shown or typed of it. The vault keeps one id once a list.
    const chosen = new Map<string, DraftEntry>();
    for (const e of entries) {
      const there = chosen.get(e.id);
      if (!there || (there.from === part && e.from !== part)) chosen.set(e.id, e);
    }
    const items = entries
      .filter((e) => chosen.get(e.id) === e)
      .map((e) => entryOut(e, part))
      .filter((e): e is Record<string, unknown> => e !== null);
    if (items.length > 0) out[list] = items;
  }
  return out;
}

/** The kinds of ID a document of these built-in types is (5.27, "Fill from documents"). */
const KIND_OF_TYPE: Record<string, IdentityIdKind> = {
  passport: 'passport',
  drivers_licence: 'driving_licence',
  national_id: 'national_id',
  visa: 'residence_permit',
};

export interface Suggestion {
  uid: string;
  documentId: string;
  title: string;
  kind: IdentityIdKind;
  /** What an 'other' ID is called: its kind of document. */
  label: string | null;
  number: string | null;
  expires: string | null;
  expiresWords: string | null;
  issued: string | null;
  issuer: string | null;
  /**
   * Where it goes: an Only me document's number into Only me, where the
   * editor may write it (the 5.27 review); anything else, the shared part.
   */
  goesTo: IdentityPart;
  /** Said when the document is seen by fewer people than where it goes; null otherwise. */
  note: string | null;
  /**
   * An ID of the same kind here already, saved, its number hidden and no
   * document linked (the 5.27 review): the document is offered as its link,
   * filling only what it lacks, never a second copy of the number — which
   * cannot be compared without showing it.
   */
  into: { uid: string; name: string } | null;
}

/** What an entry's masked value is called, in a sentence: "passport number", "Locker code". */
const secretWords = (e: DraftEntry): string =>
  e.list === 'ids'
    ? idNumberLabel({
        kind: (e.f.kind as IdentityIdKind | undefined) ?? 'other',
        label: e.f.label ?? null,
      })
    : e.f.label?.trim() || 'detail';

/** Who may write where, and who reads the shared part: what a suggestion is weighed against. */
export interface FillContext {
  /** The editor may write the Only me part (the person themselves). */
  onlyMe: boolean;
  /** Who reads the shared part besides the person and the owners (A34). */
  audience: IdentityAudience;
}

/**
 * What a person's identity documents offer the form (5.27): from each one
 * the editor can see — the list is theirs, as the vault gives it — its
 * number and its expiry, as a new ID. Not a document an ID is linked to
 * already (a saved number comes back masked, so it cannot be compared),
 * nor a number the form already has; and nothing until the editor says so.
 * Where it goes follows who sees the document: an Only me one's into Only
 * me where the editor may write it, and a suggestion says where it goes
 * whenever more people would see it there than see the document.
 */
export function suggestionsFrom(
  docs: readonly DocumentView[],
  draft: Draft,
  types: readonly DocumentTypeView[] = [],
  where: FillContext = { onlyMe: false, audience: 'owners_and_self' },
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const d of docs) {
    if (d.deleted_at || d.category !== 'identity') continue;
    const number = d.identifier?.trim() || null;
    const expires = d.expires?.date ?? null;
    if (!number && !expires) continue;
    const kind = KIND_OF_TYPE[d.type_key ?? ''] ?? 'other';
    const label =
      kind === 'other'
        ? (types.find((t) => t.key === d.type_key)?.label ?? d.title ?? 'Identity document')
        : null;
    const base = {
      uid: nextUid(),
      documentId: d.id,
      title: d.title ?? 'An identity document',
      kind,
      label,
      expiresWords: d.expires ? formatDate(d.expires) : null,
      issued: d.issued?.precision === 'day' ? d.issued.date : null,
      issuer: d.issued_by?.trim() || null,
    };
    // An ID is linked to it already.
    if (draft.entries.some((e) => e.list === 'ids' && e.documentId === d.id)) continue;
    // Already here, by a number the form can read.
    if (number !== null && draft.entries.some((e) => hasNumber(e, number))) continue;
    // A saved one of the same kind, its number hidden, linked to nothing:
    // most likely this one, typed in before the scan was filed.
    const hidden = draft.entries.find(
      (e) =>
        e.list === 'ids' &&
        (e.f.kind ?? 'other') === kind &&
        e.masked &&
        e.known === null &&
        typeof e.documentId !== 'string' &&
        typeof e.linkedBefore !== 'string',
    );
    if (hidden) {
      out.push({
        ...base,
        number: null,
        expires: (hidden.f.expires_on ?? '').trim() ? null : expires,
        expiresWords: (hidden.f.expires_on ?? '').trim() ? null : base.expiresWords,
        issued: (hidden.f.issued_on ?? '').trim() ? null : base.issued,
        issuer: (hidden.f.issuer ?? '').trim() ? null : base.issuer,
        goesTo: partOf(hidden),
        note: null,
        into: {
          uid: hidden.uid,
          name: idNumberLabel({ kind, label: hidden.f.label ?? null }).replace(/ number$/, ''),
        },
      });
      continue;
    }
    const goesTo: IdentityPart = d.visibility === 'private' && where.onlyMe ? 'only_me' : 'shared';
    const note =
      d.visibility === 'private'
        ? goesTo === 'only_me'
          ? 'From an Only me document: it goes into your Only me details.'
          : 'From an Only me document: it goes into the shared details, which the owners can see.'
        : d.visibility === 'adults' && where.audience === 'family'
          ? 'From an Adults only document: in the shared details, teens can see it too.'
          : null;
    out.push({ ...base, number, expires, goesTo, note, into: null });
  }
  return out;
}

/** Whether an ID in the form has this number, as typed or as shown. */
const hasNumber = (e: DraftEntry, number: string) =>
  e.list === 'ids' && [e.f.number, e.known].some((v) => (v ?? '').trim() === number);

/**
 * "Passport from “Mansoor’s passport”: number 563914782, expires March
 * 2031"; or, for an ID here already, "…: link it to the passport here, its
 * number hidden".
 */
export function suggestionWords(s: Suggestion): string {
  const what = [
    s.into ? `link it to the ${s.into.name} here, its number hidden` : null,
    s.number ? `number ${s.number}` : null,
    s.expiresWords ? `expires ${s.expiresWords}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const kind = s.kind === 'other' ? (s.label ?? 'ID') : IDENTITY_ID_LABELS[s.kind];
  return `${kind} from “${s.title}”: ${what}`;
}

const LIST_WORDS: Record<IdentityList, { one: string; add: string }> = {
  emails: { one: 'Email address', add: 'Add an email address' },
  phones: { one: 'Phone number', add: 'Add a phone number' },
  addresses: { one: 'Address', add: 'Add an address' },
  ids: { one: 'ID', add: 'Add an ID' },
  custom: { one: 'Detail', add: 'Add a detail of your own' },
};

const FIELD_LABEL = new Map(IDENTITY_FIELDS.map((f) => [f.key as string, f.label]));

/** Why a save was refused, in a sentence of its own: a 409 says somebody else saved first. */
interface Refusal {
  message: string;
  conflict: boolean;
}

/**
 * The form "Edit identity details" opens (5.27). Every field the catalogue
 * has (A35), in sections; for the person themselves, an Only me switch on
 * each, with the honest limit under it when on. A masked value is never
 * filled in: typed, it replaces; left alone, the vault keeps it. Saving
 * sends each part that changed, whole, made from the version it was read
 * at; somebody else's save first is said, and what they saved is shown.
 */
function IdentityForm(props: {
  view: IdentityView;
  member: Member;
  name: string;
  types?: DocumentTypeView[] | undefined;
  reveal: (part: IdentityPart, keys: string[]) => Promise<Record<string, string> | null>;
  onSaved: (view: IdentityView) => void;
  /** Somebody else saved first: the record as it is now, for the card. */
  onStale: (view: IdentityView) => void;
  /** Closed unsaved: `wrote` when a part was saved on the way, so the card reads it again. */
  onCancel: (wrote: boolean) => void;
}) {
  const { withToken, guarded } = useApp();
  const [base, setBase] = useState<IdentityView>(props.view);
  const [initial] = useState<Draft>(() => draftFrom(props.view));
  const [draft, setDraft] = useState<Draft>(initial);
  /**
   * Each part's version as this form read it, moved on only by this form's
   * own write of that part (the 5.27 review): a part somebody else saved
   * meanwhile is a 409, never written over.
   */
  const [readAt, setReadAt] = useState<Record<IdentityPart, number | null>>(() => ({
    ...props.view.versions,
  }));
  /** Each part as the vault last had it from this form: what a save is a change from. */
  const [written, setWritten] = useState(() => ({
    shared: buildPart(initial, 'shared'),
    only_me: buildPart(initial, 'only_me'),
  }));
  /** A part was saved on the way to a refusal: closed now, the card reads it again. */
  const [wrote, setWrote] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState<Suggestion[] | null>(null);
  /** Fill from documents found something, this time: emptied, it was all used or left out. */
  const [suggestedAny, setSuggestedAny] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const refusal = useRef<HTMLParagraphElement>(null);
  const fillButton = useRef<HTMLButtonElement>(null);
  const suggestionsHeading = useRef<HTMLHeadingElement>(null);
  const self = props.member.is_me;
  const onlyMeOffered = base.can_edit.only_me && base.only_me !== null;
  const who = self ? 'your' : `${props.name}’s`;

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, []);

  /** Said in the form, and heard: the alert takes the focus. */
  const [refusalHeard, setRefusalHeard] = useState(0);
  useEffect(() => {
    if (refusalHeard > 0) refusal.current?.focus();
  }, [refusalHeard]);
  const refuse = (message: string, conflict = false) => {
    setRefused({ message, conflict });
    setRefusalHeard((n) => n + 1);
  };

  const setText = (uid: string, change: Partial<DraftText>) =>
    setDraft((d) => ({
      ...d,
      texts: d.texts.map((t) => (t.uid === uid ? { ...t, ...change } : t)),
    }));
  const setEntry = (uid: string, change: (e: DraftEntry) => DraftEntry) =>
    setDraft((d) => ({ ...d, entries: d.entries.map((e) => (e.uid === uid ? change(e) : e)) }));

  /**
   * Shows a masked value in the form, asking who is asking: 'shown'; or
   * 'refused' (not confirmed, or not allowed: the card says why); or 'gone',
   * when the vault has none any more — said here, and the entry is no
   * longer masked, with nothing in it to keep.
   */
  const revealEntry = async (e: DraftEntry): Promise<'shown' | 'refused' | 'gone'> => {
    const secret = secretOf(e.list);
    if (!secret || !e.from) return 'refused';
    const key = `${e.list}.${e.id}`;
    const got = await props.reveal(e.from, [key]);
    if (!got) return 'refused';
    const value = got[key];
    if (value === undefined) {
      setEntry(e.uid, (x) => ({ ...x, masked: false, known: null }));
      refuse(`There is no ${secretWords(e)} to show any more.`);
      return 'gone';
    }
    setEntry(e.uid, (x) => {
      // What was typed over it stays; otherwise it is shown.
      const typed = (x.f[secret] ?? '').trim() !== '';
      return {
        ...x,
        known: value,
        shownInField: !typed,
        f: typed ? x.f : { ...x.f, [secret]: value },
      };
    });
    return 'shown';
  };

  /**
   * An entry to the other part: a masked value goes with it only once
   * shown, whatever is typed over it (the 5.27 review: text typed, moved,
   * then cleared lost the number).
   */
  const moveEntry = async (e: DraftEntry, onlyMe: boolean) => {
    if (e.masked && e.known === null && (await revealEntry(e)) === 'refused') return;
    setEntry(e.uid, (x) => ({ ...x, onlyMe }));
  };

  /**
   * A field of the family's own, hidden or not. Unhiding one still masked
   * shows it first: the vault keeps a hidden value hidden unless it is sent,
   * and only a reveal gives it (mergeIdentityWrite).
   */
  const hideEntry = async (e: DraftEntry, hidden: boolean) => {
    if (!hidden && e.masked && e.known === null && (await revealEntry(e)) === 'refused') return;
    setEntry(e.uid, (x) => ({ ...x, hidden }));
  };

  const addEntry = (list: IdentityList, fill: Partial<DraftEntry> = {}) => {
    const entry: DraftEntry = {
      uid: nextUid(),
      list,
      id: newEntryId(),
      onlyMe: false,
      from: null,
      f: list === 'ids' ? { kind: 'passport' } : {},
      hidden: false,
      documentId: undefined,
      linkedBefore: undefined,
      masked: false,
      known: null,
      shownInField: false,
      ...fill,
    };
    flushSync(() => setDraft((d) => ({ ...d, entries: [...d.entries, entry] })));
    form.current
      ?.querySelector<HTMLElement>(
        `[data-entry="${entry.uid}"] input, [data-entry="${entry.uid}"] select`,
      )
      ?.focus();
  };

  const removeEntry = (e: DraftEntry, addButton: HTMLElement | null) => {
    flushSync(() => setDraft((d) => ({ ...d, entries: d.entries.filter((x) => x.uid !== e.uid) })));
    addButton?.focus();
  };

  const fill = async () => {
    setSaid(null);
    try {
      const docs = await withToken((t) =>
        api.documents(t, { member_id: props.member.id, category: 'identity', limit: 100 }),
      );
      if (!docs) return;
      const found = suggestionsFrom(docs.items, draft, props.types, {
        onlyMe: onlyMeOffered,
        audience: base.audience,
      });
      flushSync(() => {
        setSuggesting(found);
        setSuggestedAny(found.length > 0);
      });
      suggestionsHeading.current?.focus();
    } catch (err) {
      refuse(describeError(err));
    }
  };

  const accept = (s: Suggestion) => {
    if (s.into) {
      // Linked to the ID here, filling only what it lacks: no number.
      const into = s.into;
      if (draft.entries.some((e) => e.uid === into.uid && typeof e.documentId === 'string')) {
        settle(s, `The ${into.name} here is linked already. “${s.title}” left out.`);
        return;
      }
      setEntry(into.uid, (x) => ({
        ...x,
        documentId: s.documentId,
        f: {
          ...x.f,
          ...(s.expires ? { expires_on: s.expires } : {}),
          ...(s.issued ? { issued_on: s.issued } : {}),
          ...(s.issuer ? { issuer: s.issuer } : {}),
        },
      }));
      settle(s, `Linked “${s.title}” to the ${into.name} here. Save to keep it.`);
      return;
    }
    // Two documents with one number: the first used, the second is here.
    if (s.number !== null && draft.entries.some((e) => hasNumber(e, s.number as string))) {
      settle(s, `That number is here already. “${s.title}” left out.`);
      return;
    }
    const entry: DraftEntry = {
      uid: nextUid(),
      list: 'ids',
      id: newEntryId(),
      onlyMe: s.goesTo === 'only_me',
      from: null,
      f: {
        kind: s.kind,
        ...(s.label ? { label: s.label } : {}),
        ...(s.number ? { number: s.number } : {}),
        ...(s.expires ? { expires_on: s.expires } : {}),
        ...(s.issued ? { issued_on: s.issued } : {}),
        ...(s.issuer ? { issuer: s.issuer } : {}),
      },
      hidden: false,
      documentId: s.documentId,
      linkedBefore: undefined,
      masked: false,
      known: null,
      shownInField: false,
    };
    setDraft((d) => ({ ...d, entries: [...d.entries, entry] }));
    settle(s, `Added from “${s.title}”. Save to keep it.`);
  };

  /** A suggestion used or passed over: the next one takes the focus, or the button. */
  const settle = (s: Suggestion, words: string) => {
    const left = (suggesting ?? []).filter((x) => x.uid !== s.uid);
    flushSync(() => {
      setSuggesting(left);
      setSaid(words);
    });
    const next = left[0];
    const target = next
      ? form.current?.querySelector<HTMLElement>(`[data-suggestion="${next.uid}"] button`)
      : fillButton.current;
    target?.focus();
  };

  /**
   * The writes a save makes, in an order that never leaves a field stored
   * nowhere (the 5.27 review): the part a field moves into is written first.
   * Fields moving both ways at once take three: Only me with what it gains
   * and still what it gives, then the shared part, then Only me as it ends.
   */
  const plan = (): Array<{ part: IdentityPart; fields: IdentityFields }> => {
    const moved = (x: { from: IdentityPart | null; onlyMe: boolean }, into: IdentityPart) =>
      x.from !== null && x.from !== into && partOf(x) === into;
    const into = (part: IdentityPart) =>
      draft.entries.some((x) => moved(x, part)) ||
      draft.texts.some((x) => moved(x, part) && x.value.trim() !== '');
    const end = { shared: buildPart(draft, 'shared'), only_me: buildPart(draft, 'only_me') };
    if (into('only_me') && into('shared')) {
      // Only me, still holding what leaves it for the shared part.
      const holding: Draft = {
        texts: draft.texts.map((x) => (moved(x, 'shared') ? { ...x, onlyMe: true } : x)),
        entries: draft.entries.map((x) => (moved(x, 'shared') ? { ...x, onlyMe: true } : x)),
      };
      return [
        { part: 'only_me', fields: buildPart(holding, 'only_me') },
        { part: 'shared', fields: end.shared },
        { part: 'only_me', fields: end.only_me },
      ];
    }
    const order: IdentityPart[] = into('only_me') ? ['only_me', 'shared'] : ['shared', 'only_me'];
    return order.map((part) => ({ part, fields: end[part] }));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const unshown = movedUnshown(draft)[0];
    if (unshown) {
      refuse(
        `Show the ${secretWords(unshown)} first: it moves with its ${unshown.list === 'ids' ? 'ID' : 'detail'}.`,
      );
      return;
    }
    const last = { ...written };
    const steps = plan().filter(
      (st) =>
        base.can_edit[st.part] &&
        (st.part === 'shared' || base.only_me !== null) &&
        identityChanges(last[st.part], st.fields).length > 0,
    );
    if (steps.length === 0) {
      props.onCancel(wrote);
      return;
    }
    setBusy(true);
    setRefused(null);
    const at = { ...readAt };
    let now = base;
    try {
      for (const st of steps) {
        if (identityChanges(last[st.part], st.fields).length === 0) continue;
        // Another person's: an owner power since the Phase 5 exit (A54),
        // asked for here as showing their numbers is; refused, nothing more.
        const saved = await guarded((t) =>
          api.updateIdentity(t, props.member.id, {
            part: st.part,
            version: at[st.part] ?? 0,
            fields: st.fields,
          }),
        );
        if (!saved) return;
        // This part's version, from this write; the other's stays as read.
        at[st.part] = saved.versions[st.part];
        last[st.part] = st.fields;
        setWrote(true);
        now = saved;
      }
      props.onSaved(now);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'conflict') {
        // Somebody else's change, kept: read again, and shown, for these
        // changes to be made again on top of it (as 5.25's Edit details) —
        // and handed to the card, so that closing the form shows it too and
        // the next edit starts from it (the 5.27 review). Not read: the card
        // reads it again when the form closes.
        const fresh = await withToken((t) => api.identity(t, props.member.id)).catch(() => null);
        if (fresh) props.onStale(fresh);
        else setWrote(true);
        if (fresh) {
          const again = draftFrom(fresh);
          setBase(fresh);
          setReadAt({ ...fresh.versions });
          setWritten({
            shared: buildPart(again, 'shared'),
            only_me: buildPart(again, 'only_me'),
          });
          setDraft(again);
          setSuggesting(null);
        }
        refuse(
          `Someone else changed ${who} identity details while you were editing. What they saved is shown now: make your changes again, then save.`,
          true,
        );
      } else {
        // A part written before the refusal keeps the version it was given;
        // tried again, it is made from that, and is no change.
        setReadAt(at);
        setWritten(last);
        refuse(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const onlyMeSwitch = (
    id: string,
    label: string,
    on: boolean,
    change: (on: boolean) => void,
    disabled = false,
  ) =>
    onlyMeOffered && !disabled ? (
      <div className="identity-only-me-switch">
        <label className="switch">
          <input
            id={id}
            type="checkbox"
            role="switch"
            checked={on}
            aria-label={`Only me: ${label}`}
            aria-describedby={on ? `${id}-limit` : undefined}
            onChange={(ev) => change(ev.target.checked)}
          />
          <span aria-hidden="true">Only me</span>
        </label>
        {on && (
          <span id={`${id}-limit`} className="muted identity-limit">
            {ONLY_ME_LIMIT}
          </span>
        )}
      </div>
    ) : null;

  const textField = (t: DraftText) => {
    const label = FIELD_LABEL.get(t.key) ?? t.key;
    const id = `idf-${t.uid}`;
    const twin = draft.texts.some((x) => x.key === t.key && x.uid !== t.uid);
    const shownLabel = twin && t.onlyMe ? `${label} (Only me)` : label;
    let input: ReactNode;
    if (t.key === 'sex') {
      input = (
        <Select
          id={id}
          label={shownLabel}
          value={t.value}
          options={[
            { value: '', label: 'Not given' },
            ...IDENTITY_SEXES.map((s) => ({ value: s, label: SEX_WORDS[s] ?? s })),
          ]}
          onChange={(v) => setText(t.uid, { value: v })}
        />
      );
    } else if (t.key === 'notes') {
      input = (
        <TextArea
          id={id}
          label={shownLabel}
          value={t.value}
          maxLength={10_000}
          onChange={(v) => setText(t.uid, { value: v })}
        />
      );
    } else {
      const hint =
        t.key === 'country_of_birth'
          ? 'Its two letters, as on a passport: GB, PK, US.'
          : t.key === 'nationalities'
            ? 'Two letters each, separated by commas: GB, PK.'
            : undefined;
      input = (
        <Field
          id={id}
          label={shownLabel}
          value={t.value}
          required={false}
          hint={hint}
          maxLength={t.key === 'country_of_birth' ? 2 : t.key === 'nationalities' ? 60 : 200}
          onChange={(v) => setText(t.uid, { value: v })}
        />
      );
    }
    return (
      <div key={t.uid} className="identity-field">
        {input}
        {onlyMeSwitch(
          `${id}-only-me`,
          label,
          t.onlyMe,
          (on) => setText(t.uid, { onlyMe: on }),
          // The other part has this field already: it stays where it is.
          twin,
        )}
      </div>
    );
  };

  // Two IDs called the same are told apart, in the form as on the card.
  const idSuffix = idSuffixes(
    draft.entries
      .filter((x) => x.list === 'ids')
      .map((x) => ({
        key: x.uid,
        kind: x.f.kind ?? 'other',
        label: x.f.label,
        issuer: x.f.issuer,
      })),
  );

  const entryFields = (e: DraftEntry, n: number) => {
    const id = `ide-${e.uid}`;
    const field = (
      key: string,
      label: string,
      opts: { type?: string; max?: number; hint?: string | undefined } = {},
    ) => (
      <Field
        id={`${id}-${key}`}
        label={label}
        {...(opts.type ? { type: opts.type } : {})}
        value={e.f[key] ?? ''}
        required={false}
        hint={opts.hint}
        maxLength={opts.max ?? 200}
        onChange={(v) => setEntry(e.uid, (x) => ({ ...x, f: { ...x.f, [key]: v } }))}
      />
    );
    const kind = (e.f.kind as IdentityIdKind | undefined) ?? 'other';
    const suffix = idSuffix.get(e.uid) ?? '';
    const legend =
      e.list === 'ids'
        ? `${IDENTITY_ID_LABELS[kind] ?? 'ID'}${e.f.label?.trim() ? `: ${e.f.label.trim()}` : ''}${suffix}`
        : `${LIST_WORDS[e.list].one} ${n}`;
    const secret = secretOf(e.list);
    const secretLabel =
      e.list === 'ids'
        ? capitalised(idNumberLabel({ kind, label: e.f.label ?? null })) + suffix
        : e.f.label?.trim() || 'Value';
    // Moved to the other part, it goes with the entry: not "kept" where it was.
    const moving = e.from !== null && e.from !== partOf(e);
    const what = e.list === 'ids' ? 'ID' : 'detail';
    const maskedField = (key: string) => (
      <Field
        id={`${id}-${key}`}
        label={secretLabel}
        value={e.f[key] ?? ''}
        required={false}
        maxLength={key === 'number' ? 80 : 2000}
        {...(e.shownInField
          ? {}
          : { placeholder: moving ? 'Moves with it, hidden' : 'Kept, and hidden' })}
        hint={
          e.shownInField
            ? 'Shown. Clear it to remove it.'
            : moving
              ? `It moves with this ${what} unless you type a new one here.`
              : 'Kept as it is unless you type a new one here.'
        }
        onChange={(v) => setEntry(e.uid, (x) => ({ ...x, f: { ...x.f, [key]: v } }))}
      />
    );
    return (
      <fieldset key={e.uid} className="identity-entry stack" data-entry={e.uid}>
        <legend>{legend}</legend>
        {e.list === 'ids' && (
          <Select
            id={`${id}-kind`}
            label="Kind of ID"
            value={kind}
            options={IDENTITY_ID_KINDS.map((k) => ({ value: k, label: IDENTITY_ID_LABELS[k] }))}
            onChange={(v) => setEntry(e.uid, (x) => ({ ...x, f: { ...x.f, kind: v } }))}
          />
        )}
        {e.list === 'custom'
          ? field('label', 'What it is called', { max: 60 })
          : field('label', e.list === 'ids' ? 'Its name (optional)' : 'What it is for (optional)', {
              max: 60,
              hint: e.list === 'ids' ? undefined : 'For example: Home, Work',
            })}
        {(e.list === 'emails' || e.list === 'phones') &&
          field('value', e.list === 'emails' ? 'Email address' : 'Phone number', {
            type: e.list === 'emails' ? 'email' : 'tel',
          })}
        {e.list === 'addresses' && (
          <>
            {field('line1', 'Address line 1')}
            {field('line2', 'Address line 2')}
            {field('line3', 'Address line 3')}
            {field('city', 'Town or city')}
            {field('region', 'County, state or region')}
            {field('postal_code', 'Postcode', { max: 30 })}
            {field('country', 'Country', { max: 2, hint: 'Its two letters: GB, PK, US.' })}
          </>
        )}
        {e.list === 'ids' && (
          <>
            {e.masked ? maskedField('number') : field('number', secretLabel, { max: 80 })}
            {field('issuer', 'Issued by')}
            {field('issued_on', 'Issued on', { type: 'date' })}
            {field('expires_on', 'Expires on', { type: 'date' })}
          </>
        )}
        {e.list === 'custom' && (
          <>
            {e.masked && secret ? (
              maskedField(secret)
            ) : (
              <TextArea
                id={`${id}-value`}
                label="Its value"
                value={e.f.value ?? ''}
                maxLength={2000}
                onChange={(v) => setEntry(e.uid, (x) => ({ ...x, f: { ...x.f, value: v } }))}
              />
            )}
            <Switch
              id={`${id}-hidden`}
              label={`Hide ${e.f.label?.trim() || 'this detail'} until it is shown`}
              word="Hidden until shown"
              checked={e.hidden}
              onChange={(on) => void hideEntry(e, on)}
            />
          </>
        )}
        {e.masked && e.known === null && e.from && (
          <Button
            kind="quiet"
            onClick={() =>
              void revealEntry(e).then((outcome) => {
                const shown = outcome === 'shown';
                // Shown where it is kept: the field itself.
                if (shown && secret) document.getElementById(`${id}-${secret}`)?.focus();
              })
            }
          >
            Show {secretLabel.charAt(0).toLowerCase() + secretLabel.slice(1)}
          </Button>
        )}
        {typeof e.documentId === 'string' && (
          <p className="muted identity-linked">
            On a document.{' '}
            <Link to={`/documents/${e.documentId}`} className="quiet-link">
              Open it
            </Link>{' '}
            <button
              type="button"
              className="btn btn-link"
              onClick={() => setEntry(e.uid, (x) => ({ ...x, documentId: null }))}
            >
              Unlink it
            </button>
          </p>
        )}
        {onlyMeSwitch(`${id}-only-me`, legend, e.onlyMe, (on) => void moveEntry(e, on))}
        <div className="row">
          <button
            type="button"
            className="btn btn-quiet"
            aria-label={`Remove ${legend}`}
            onClick={(ev) =>
              removeEntry(
                e,
                ev.currentTarget
                  .closest('.identity-list')
                  ?.querySelector<HTMLElement>('.identity-add') ?? null,
              )
            }
          >
            Remove
          </button>
        </div>
      </fieldset>
    );
  };

  const listOf = (list: IdentityList, title: string) => {
    const entries = draft.entries.filter((e) => e.list === list);
    return (
      <div className="identity-list stack" key={list}>
        {/* Not said twice: Government IDs, in Government IDs. */}
        {!SECTIONS.some((x) => x.title === title) && <h3 className="identity-h4">{title}</h3>}
        {entries.map((e, i) => entryFields(e, i + 1))}
        <button type="button" className="btn btn-quiet identity-add" onClick={() => addEntry(list)}>
          {LIST_WORDS[list].add}
        </button>
      </div>
    );
  };

  const sectionFields = (section: string) =>
    IDENTITY_FIELDS.filter((f) => f.section === section).map((f) => {
      if ((IDENTITY_LISTS as readonly string[]).includes(f.key)) {
        return listOf(f.key as IdentityList, f.label);
      }
      return (
        <Fragment key={f.key}>{draft.texts.filter((t) => t.key === f.key).map(textField)}</Fragment>
      );
    });

  return (
    <form
      ref={form}
      onSubmit={(ev) => void save(ev)}
      className="stack identity-form"
      aria-label={self ? 'Your identity details' : `${props.name}’s identity details`}
    >
      {refused && (
        <p ref={refusal} className="error" role="alert" tabIndex={-1}>
          {refused.message}
        </p>
      )}
      {onlyMeOffered && <p className="muted">Mark a field Only me to keep it to yourself.</p>}
      <div className="identity-fill stack">
        <Button kind="quiet" ref={fillButton} onClick={() => void fill()}>
          Fill from documents
        </Button>
        <p className="muted">
          Suggests a number and an expiry date from {self ? 'your' : `${props.name}’s`} identity
          documents that you can see. Nothing is filled in until you choose it.
        </p>
        {suggesting && (
          <div className="stack" aria-labelledby="identity-suggest-h">
            <h3
              id="identity-suggest-h"
              className="identity-h4"
              tabIndex={-1}
              ref={suggestionsHeading}
            >
              {suggesting.length > 0
                ? 'From documents'
                : suggestedAny
                  ? 'That’s all of them'
                  : 'Nothing to suggest'}
            </h3>
            {suggesting.length === 0 ? (
              !suggestedAny && (
                <p className="muted">
                  None of {self ? 'your' : `${props.name}’s`} identity documents that you can see
                  has a number or an expiry date that isn’t here already.
                </p>
              )
            ) : (
              <ul className="list identity-suggestions">
                {suggesting.map((s) => (
                  <li key={s.uid} className="place" data-suggestion={s.uid}>
                    <span>{suggestionWords(s)}</span>
                    {s.note && (
                      <span id={`${s.uid}-note`} className="muted">
                        {s.note}
                      </span>
                    )}
                    <span className="row">
                      <button
                        type="button"
                        className="btn btn-quiet"
                        aria-label={`Use this: ${suggestionWords(s)}`}
                        aria-describedby={s.note ? `${s.uid}-note` : undefined}
                        onClick={() => accept(s)}
                      >
                        Use this
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet"
                        aria-label={`Not this: ${suggestionWords(s)}`}
                        onClick={() => settle(s, 'Left out.')}
                      >
                        Not this
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="notice status-line" role="status">
          {said}
        </p>
      </div>
      {SECTIONS.map((s) => (
        <fieldset key={s.key} className="identity-section stack">
          <legend className="identity-h3">{s.title}</legend>
          {sectionFields(s.key)}
        </fieldset>
      ))}
      <div className="row">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={() => props.onCancel(wrote)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ the notice

/**
 * "From 6 October at 07:00, all adults will see your shared identity
 * details." (A34) Everybody with a sign-in is told of a wider audience
 * while it waits its 72 hours, on the household's clock, with the way to
 * their own details — to mark anything Only me before then, where they may.
 */
export function IdentityNotice(props: { memberId: string | null | undefined }) {
  const { caps, authVersion } = useApp();
  const offered = caps?.features.member_identity === true;
  const { data } = useLoad(
    async (t) => {
      if (!offered) return null;
      const [audience, profile] = await Promise.all([api.identityAudience(t), api.profile(t)]);
      return { audience, timezone: profile.timezone ?? 'UTC' };
    },
    [authVersion, offered],
  );
  const pending = data?.audience.pending;
  if (!pending || !data) return null;
  const when = whenWords(pending.notice_until, data.timezone);
  const who = pending.to === 'family' ? 'everyone in the family but viewers' : 'all adults';
  const role = storedRole();
  const mayMark = role !== 'viewer';
  return (
    <div className="attention attention-calm identity-notice" role="status">
      <strong>
        From {when}, {who} will see your shared identity details.
      </strong>
      <span className="muted">
        {mayMark
          ? 'Mark anything Only me before then.'
          : 'Ask an owner if anything kept for you should change before then.'}
      </span>
      <span className="row">
        {props.memberId && (
          <Link to={`/people/${props.memberId}#identity`} className="quiet-link">
            Look at yours
          </Link>
        )}
        {data.audience.can_change && (
          <Link to="/settings/family" className="quiet-link">
            Who can see identity details
          </Link>
        )}
      </span>
    </div>
  );
}

/** A moment on the household's clock: "6 October at 07:00". */
export function whenWords(iso: string, timezone: string): string {
  const at = new Date(iso);
  try {
    return shareEndWords(at, timezone || 'UTC', { weekday: false });
  } catch {
    return shareEndWords(at, 'UTC', { weekday: false });
  }
}
