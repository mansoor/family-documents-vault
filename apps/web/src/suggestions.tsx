import {
  autoTitle,
  CUE_WORDS,
  formatDate,
  issuedByLabel,
  PROPOSAL_FIELDS,
  type DateValue,
  type DetailProposal,
  type DocumentTypeView,
  type DocumentView,
  type ProposalCue,
  type ProposalField,
} from '@fdv/shared';
import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, type DocumentInput, type Member } from './api.js';
import { describeError, useApp } from './app-context.js';
import { coreRule } from './details.js';
import { Button } from './ui.js';

/**
 * What a document's pages propose (5.37, A44), as chips a person taps:
 * after Save, on the document's page, and on its Edit card. A chip fills
 * only a field that is empty, never anything typed, and nothing is filled
 * in until it is tapped. Each says how sure the vault is, lightly:
 * "suggested · 92%".
 */

/** While the vault is still reading the pages, it is asked again this often… */
const PENDING_EVERY_MS = 5_000;
/** …this many times: for up to a minute. */
const PENDING_TRIES = 12;

/** Whether this vault proposes details from the pages. */
export function useSuggestionsOffered(): boolean {
  const { caps } = useApp();
  return caps?.features.detail_suggestions === true;
}

/** What the pages proposed, and the version whose pages they were. */
export interface PagesRead {
  versionId: string;
  proposal: DetailProposal;
}

/**
 * What the pages propose for `documentId`: asked of the vault, and asked
 * again every five seconds for a minute while it is still reading them.
 * Null until there is an answer, when `enabled` is false, and whenever the
 * vault's last answer was not one (the review: a new version's pages being
 * read, the old version's chips were still offered and saved). Asked again
 * when `refresh` changes — the document was saved — keeping what it had
 * until the answer comes; forgotten at once when `versionId`, the newest
 * version, changes.
 */
export function useDetailSuggestions(
  documentId: string | undefined,
  enabled: boolean,
  opts: { refresh?: string | undefined; versionId?: string | null | undefined } = {},
): PagesRead | null {
  const { withToken } = useApp();
  const { refresh, versionId } = opts;
  const [read, setRead] = useState<PagesRead | null>(null);
  const [forVersion, setForVersion] = useState(versionId);
  if (forVersion !== versionId) {
    // Another version: what the last one's pages said is not this one's.
    setForVersion(versionId);
    setRead(null);
  }
  useEffect(() => {
    if (!documentId || !enabled) return;
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const r = await withToken((t) => api.detailSuggestions(t, documentId));
        if (stopped || !r) return;
        if (r.state === 'ready' && r.version_id) {
          setRead({ versionId: r.version_id, proposal: r.proposal });
          return;
        }
        setRead(null);
        if (r.state === 'pending' && tries < PENDING_TRIES) {
          tries += 1;
          timer = setTimeout(() => void ask(), PENDING_EVERY_MS);
        }
      } catch {
        // An offer, not a need: the page and the card work without it.
      }
    };
    void ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [documentId, enabled, refresh, versionId, withToken]);
  if (!enabled || !read) return null;
  // Only the newest version's pages, when the caller says which it is.
  return versionId === undefined || read.versionId === versionId ? read : null;
}

const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/** "suggested · 92%": how sure the vault is, with the cue it read in words beside it. */
export function SuggestedMark(props: { confidence: number; cue: ProposalCue }) {
  return (
    <span className="mark-sugg" title={`Read from the pages: ${lowerFirst(CUE_WORDS[props.cue])}`}>
      suggested · {Math.round(props.confidence * 100)}%
    </span>
  );
}

/** One proposal, as a chip: what it would fill in, then how sure. */
export function SuggestionChip(props: {
  label: string;
  confidence: number;
  cue: ProposalCue;
  onPick: () => void;
  disabled?: boolean;
  /** Said first to a screen reader, where the chip stands apart from its field. */
  field?: string;
}) {
  const pct = Math.round(props.confidence * 100);
  return (
    <button
      type="button"
      className="pill pill-sugg"
      onClick={props.onPick}
      disabled={props.disabled}
      aria-label={props.field ? `${props.field}: ${props.label} suggested · ${pct}%` : undefined}
    >
      <span className="pill-sugg-value">{props.label}</span>{' '}
      <SuggestedMark confidence={props.confidence} cue={props.cue} />
    </button>
  );
}

/** A proposal's value as a chip says it: "Passport?", "Sara?", "14 Mar 2031?", "From Aviva?". */
export function chipWords(
  field: ProposalField,
  proposal: DetailProposal,
  types: readonly DocumentTypeView[],
  members: readonly Member[],
): string | null {
  switch (field) {
    case 'type_key': {
      const t = types.find((x) => x.key === proposal.type_key?.value);
      return t ? `${t.label}?` : null;
    }
    case 'owner_member_id': {
      const m = members.find((x) => x.id === proposal.owner_member_id?.value);
      return m ? `${m.display_name}?` : null;
    }
    case 'issued':
    case 'expires': {
      const d = proposal[field]?.value;
      return d ? `${formatDate(d)}?` : null;
    }
    case 'identifier':
      return proposal.identifier ? `${proposal.identifier.value}?` : null;
    case 'issued_by':
      return proposal.issued_by ? `From ${proposal.issued_by.value}?` : null;
  }
}

/** Whether the document already has a value for the field: then it is never offered. */
function hasValue(doc: DocumentView, field: ProposalField): boolean {
  switch (field) {
    case 'type_key':
      return doc.type_key !== null;
    case 'owner_member_id':
      return doc.owner_member_id !== null;
    case 'issued':
      return doc.issued !== null;
    case 'expires':
      return doc.expires !== null;
    case 'identifier':
      return Boolean(doc.identifier?.trim());
    case 'issued_by':
      return Boolean(doc.issued_by?.trim());
  }
}

/**
 * The name a document is given while nobody has typed one (the card's
 * rule): from its kind, its person, its issuer and its issue date. Null for
 * a document with no kind.
 */
function automaticName(
  type: DocumentTypeView | undefined,
  members: readonly Member[],
  values: { owner: string | null; issued_by: string | null; issued: DateValue | null },
): string | null {
  if (!type) return null;
  return autoTitle(
    type,
    members.find((m) => m.id === values.owner),
    { issued_by: values.issued_by, issued: values.issued },
  );
}

/** Where "Not now" is kept, for one person in one household, by document (decision 16). */
const notNowKey = (household: string, member: string, documentId: string) =>
  `fdv.pages-not-now.${household}.${member}.${documentId}`;

function notNowSaid(key: string | null): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * After Save, on the document's own page (5.37): "We read the pages — is
 * this right?", with a chip for each empty field its newest version's pages
 * propose. A tap saves that one field, as the document was when the page
 * was loaded (If-Match), and only while those pages are still the newest:
 * if it has changed since, nothing is saved, and the page is loaded again.
 * While nobody has typed a name, a tap renames it as the card would. "Not
 * now" puts the card away for this person and this document. Shown only to
 * whoever may change it.
 */
export function PagesSuggest(props: {
  doc: DocumentView;
  types: readonly DocumentTypeView[];
  members: readonly Member[];
  /** The document as the vault holds it after a chip was tapped. */
  onSaved: (doc: DocumentView) => void;
  /** Changed somewhere else: load it again. */
  onStale: () => Promise<void>;
  /** Where the place goes once the card has been put away. */
  onGone: () => void;
}) {
  const { doc, types, members } = props;
  const { withToken, session } = useApp();
  const household = session.info?.household_id;
  const member = session.info?.member_id;
  const keyed = household && member ? notNowKey(household, member, doc.id) : null;
  const [dismissed, setDismissed] = useState(() => notNowSaid(keyed));
  // Put away for this document: the vault is not even asked.
  const read = useDetailSuggestions(doc.id, !dismissed, {
    refresh: doc.etag,
    versionId: doc.latest_version_id,
  });
  const proposal = read?.proposal ?? null;
  const [busy, setBusy] = useState<ProposalField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tapped, setTapped] = useState(0);
  const chips = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const errorNote = useRef<HTMLParagraphElement>(null);
  // Where the place goes after a tap: the chip now where the tapped one was.
  const placeAt = useRef<number | null>(null);
  const placeOnError = useRef(false);

  const type = types.find((t) => t.key === doc.type_key);
  const word = (key: 'issued' | 'expires' | 'identifier', fallback: string) =>
    coreRule(type, key).label ?? fallback;
  const fieldName: Record<ProposalField, string> = {
    type_key: 'What it is',
    owner_member_id: 'Whose it is',
    issued: word('issued', 'Issued'),
    expires: word('expires', 'Expires'),
    identifier: word('identifier', 'Number'),
    issued_by: issuedByLabel(type),
  };
  const offers = proposal
    ? PROPOSAL_FIELDS.flatMap((field) => {
        const p = proposal[field];
        if (!p || hasValue(doc, field)) return [];
        const label = chipWords(field, proposal, types, members);
        return label ? [{ field, label, confidence: p.confidence, cue: p.cue }] : [];
      })
    : [];
  const done = tapped > 0 && proposal !== null && offers.length === 0;

  useEffect(() => {
    if (placeOnError.current) {
      placeOnError.current = false;
      errorNote.current?.focus();
      return;
    }
    if (placeAt.current === null || proposal === null) return;
    const at = placeAt.current;
    placeAt.current = null;
    const left = chips.current?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    const next = left[Math.min(at, left.length - 1)];
    if (next) next.focus();
    else status.current?.focus();
  });

  if (dismissed || !proposal || (offers.length === 0 && !done)) return null;

  const pick = async (field: ProposalField, index: number) => {
    const p = proposal[field];
    if (!p || hasValue(doc, field)) return;
    // Only the newest version's pages: another version since, and they are not its.
    if (read?.versionId !== doc.latest_version_id) {
      await props.onStale();
      return;
    }
    const body: DocumentInput = {};
    let nextType = type;
    let owner = doc.owner_member_id;
    let issuedBy = doc.issued_by ?? null;
    let issued = doc.issued;
    if (field === 'type_key') {
      const t = types.find((x) => x.key === p.value);
      if (!t) return;
      body.type_key = t.key;
      body.category = t.category;
      nextType = t;
    } else if (field === 'owner_member_id') {
      owner = proposal.owner_member_id?.value ?? null;
      body.owner_member_id = owner;
    } else if (field === 'issued') {
      issued = proposal.issued?.value ?? null;
      body.issued = issued;
    } else if (field === 'expires') body.expires = proposal.expires?.value ?? null;
    else if (field === 'identifier') body.identifier = proposal.identifier?.value ?? null;
    else {
      issuedBy = proposal.issued_by?.value ?? null;
      body.issued_by = issuedBy;
    }
    // The name follows until somebody types one (the review: "Passport"
    // stayed "Passport" when the person was tapped after the kind).
    const before = automaticName(type, members, {
      owner: doc.owner_member_id,
      issued_by: doc.issued_by ?? null,
      issued: doc.issued,
    });
    if (doc.title === null || doc.title === before) {
      const after = automaticName(nextType, members, { owner, issued_by: issuedBy, issued });
      if (after && after !== doc.title) body.title = after;
    }
    setBusy(field);
    setError(null);
    try {
      const saved = await withToken((t) => api.updateDocument(t, doc.id, body, doc.etag));
      if (saved) {
        placeAt.current = index;
        setTapped((n) => n + 1);
        props.onSaved(saved);
      }
    } catch (err) {
      placeOnError.current = true;
      if (err instanceof ApiRequestError && err.status === 409) {
        setError(
          'This document was changed somewhere else, so it has been loaded again. Check what the pages say against it.',
        );
        await props.onStale();
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card sugg-card" aria-labelledby="sugg-h">
      <h2 id="sugg-h" className="sugg-h">
        We read the pages — is this right?
      </h2>
      {done ? (
        <p className="muted" role="status" tabIndex={-1} ref={status}>
          That is everything the pages said. You can change any of it with Edit.
        </p>
      ) : (
        <p className="muted">Tap what is right to fill it in. Nothing is filled in until you do.</p>
      )}
      <div className="sugg-rows" ref={chips}>
        {offers.map((o, i) => (
          <div className="sugg-row" key={o.field}>
            <span className="sugg-field" aria-hidden="true">
              {fieldName[o.field]}
            </span>
            <SuggestionChip
              field={fieldName[o.field]}
              label={o.label}
              confidence={o.confidence}
              cue={o.cue}
              disabled={busy !== null}
              onPick={() => void pick(o.field, i)}
            />
          </div>
        ))}
      </div>
      {error && (
        <p className="error" role="alert" tabIndex={-1} ref={errorNote}>
          {error}
        </p>
      )}
      <Button
        kind="quiet"
        onClick={() => {
          setDismissed(true);
          try {
            // "Not now" is remembered for this document; a finished card is just closed.
            if (keyed && !done) localStorage.setItem(keyed, '1');
          } catch {
            // Kept for this visit only, then.
          }
          props.onGone();
        }}
      >
        {done ? 'Close' : 'Not now'}
      </Button>
    </section>
  );
}
