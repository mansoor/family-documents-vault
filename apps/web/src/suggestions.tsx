import {
  autoTitle,
  CUE_WORDS,
  formatDate,
  issuedByLabel,
  PROPOSAL_FIELDS,
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
import { Button, ErrorNote } from './ui.js';

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

/** Whether this vault proposes details from the pages, and this reader may be offered them. */
export function useSuggestionsOffered(): boolean {
  const { caps } = useApp();
  return caps?.features.detail_suggestions === true;
}

/**
 * What the pages propose for `documentId`: asked of the vault, and asked
 * again every five seconds for a minute while it is still reading them.
 * Null until there is an answer, and when `enabled` is false. Asked afresh
 * when `version` changes: the document was saved, and what it has now is
 * not proposed again.
 */
export function useDetailSuggestions(
  documentId: string | undefined,
  enabled: boolean,
  version: string | undefined,
): DetailProposal | null {
  const { withToken } = useApp();
  const [proposal, setProposal] = useState<DetailProposal | null>(null);
  useEffect(() => {
    if (!documentId || !enabled) return;
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const r = await withToken((t) => api.detailSuggestions(t, documentId));
        if (stopped || !r) return;
        if (r.state === 'ready') setProposal(r.proposal);
        else if (r.state === 'pending' && tries < PENDING_TRIES) {
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
  }, [documentId, enabled, version, withToken]);
  return enabled ? proposal : null;
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
 * After Save, on the document's own page (5.37): "We read the pages — is
 * this right?", with a chip for each empty field the pages propose. A tap
 * saves that one field, as the document was when the page was loaded
 * (If-Match): if it has been changed elsewhere since, nothing is saved,
 * and the page is loaded again. Shown only to whoever may change it.
 */
export function PagesSuggest(props: {
  doc: DocumentView;
  types: readonly DocumentTypeView[];
  members: readonly Member[];
  /** The document as the vault holds it after a chip was tapped. */
  onSaved: (doc: DocumentView) => void;
  /** Changed somewhere else: load it again. */
  onStale: () => Promise<void>;
  /** Where the place goes once the card has gone. */
  onGone: () => void;
}) {
  const { doc, types, members } = props;
  const { withToken } = useApp();
  const proposal = useDetailSuggestions(doc.id, true, doc.etag);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<ProposalField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chips = useRef<HTMLDivElement>(null);
  const placeAfterSave = useRef(false);

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

  // After a tap: the place goes to the next chip, or, with none left, on.
  useEffect(() => {
    if (!placeAfterSave.current || proposal === null) return;
    placeAfterSave.current = false;
    const next = chips.current?.querySelector<HTMLButtonElement>('button');
    if (next) next.focus();
    else props.onGone();
  });

  if (dismissed || !proposal || offers.length === 0) return null;

  const pick = async (field: ProposalField) => {
    const p = proposal[field];
    if (!p || hasValue(doc, field)) return;
    const body: DocumentInput = {};
    if (field === 'type_key') {
      const t = types.find((x) => x.key === p.value);
      if (!t) return;
      body.type_key = t.key;
      body.category = t.category;
      // A document with no name takes the one the card would give it.
      if (doc.title === null) {
        body.title = autoTitle(
          t,
          members.find((m) => m.id === doc.owner_member_id),
          doc,
        );
      }
    } else if (field === 'owner_member_id')
      body.owner_member_id = proposal.owner_member_id?.value ?? null;
    else if (field === 'issued') body.issued = proposal.issued?.value ?? null;
    else if (field === 'expires') body.expires = proposal.expires?.value ?? null;
    else if (field === 'identifier') body.identifier = proposal.identifier?.value ?? null;
    else body.issued_by = proposal.issued_by?.value ?? null;
    setBusy(field);
    setError(null);
    try {
      const saved = await withToken((t) => api.updateDocument(t, doc.id, body, doc.etag));
      if (saved) {
        placeAfterSave.current = true;
        props.onSaved(saved);
      }
    } catch (err) {
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
      <p className="muted">Tap what is right to fill it in. Nothing is filled in until you do.</p>
      <div className="sugg-rows" ref={chips}>
        {offers.map((o) => (
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
              onPick={() => void pick(o.field)}
            />
          </div>
        ))}
      </div>
      <ErrorNote message={error} />
      <Button
        kind="quiet"
        onClick={() => {
          setDismissed(true);
          props.onGone();
        }}
      >
        Not now
      </Button>
    </section>
  );
}
