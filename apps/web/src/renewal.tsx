import {
  formatDate,
  issuedByLabel,
  RENEWAL_UNDO_MINUTES,
  renewalOffers,
  type DateValue,
  type DocumentTypeView,
  type DocumentView,
  type RenewalField,
  type RenewalInput,
  type RenewalOffer,
} from '@fdv/shared';
import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, type Member } from './api.js';
import { describeError, useApp } from './app-context.js';
import { Toast, type ReviewToast } from './batch-review.js';
import { coreRule } from './details.js';
import { chipsPutAway, PagesSuggest, useDetailSuggestions, type PagesRead } from './suggestions.js';
import { Button } from './ui.js';

/**
 * What a document's newest version's pages say, on its page (0.9.0; the
 * owner's report of 7 Nov 2026: a renewed licence added from the phone kept
 * its old dates, and nothing offered the new ones).
 *
 * The pages are asked once, for both cards: "The new version says:" — each
 * field the new version's pages read otherwise than the document holds,
 * "Expires 1 Mar 2033 (was 1 Mar 2025)" — and, under it, the chips for the
 * fields still empty (5.37). Shown only to whoever may change the document
 * (the page decides), and only while the newest version's details are still
 * the version before's: once somebody confirms them — here, or with Edit —
 * it has nothing to ask.
 */
export function PagesOffers(props: {
  doc: DocumentView;
  types: readonly DocumentTypeView[];
  members: readonly Member[];
  onSaved: (doc: DocumentView) => void;
  onStale: () => Promise<void>;
  onGone: () => void;
}) {
  const { doc } = props;
  const { session } = useApp();
  const household = session.info?.household_id;
  const member = session.info?.member_id;
  // Both put away ("Not now"): the vault is not even asked.
  const chipsAway = chipsPutAway(household, member, doc.id);
  const renewalAway =
    doc.details_unconfirmed !== true ||
    !doc.latest_version_id ||
    saidNotNow(household && member ? notNowKey(household, member, doc.latest_version_id) : null);
  const read = useDetailSuggestions(doc.id, !(chipsAway && renewalAway), {
    refresh: doc.etag,
    versionId: doc.latest_version_id,
  });
  return (
    <>
      <NewVersionSays {...props} read={read} />
      <PagesSuggest key={`pages-${doc.id}`} {...props} read={read} />
    </>
  );
}

/** Where "Not now" is kept: for one person, and one version (decision 16, by version). */
const notNowKey = (household: string, member: string, versionId: string) =>
  `fdv.new-version-not-now.${household}.${member}.${versionId}`;

function saidNotNow(key: string | null): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

const valueWords = (o: { field: RenewalField; value: DateValue | string }) =>
  o.field === 'issued' || o.field === 'expires'
    ? formatDate(o.value as DateValue)
    : (o.value as string);

/**
 * "The new version says:", each field it reads otherwise as new (was old),
 * ticked unless the reading is weak — marked "check this" then, and left
 * unticked. Use these makes the ticked ones the version's own, as a renewal
 * (the vault redoes its reminders, as a batch's new version), on the
 * document as the page loaded it: changed since, or another version newest,
 * and nothing is saved and the page is loaded again. A toast says what was
 * done, with Undo for RENEWAL_UNDO_MINUTES. Not now puts it away for this
 * person and this version.
 */
export function NewVersionSays(props: {
  doc: DocumentView;
  types: readonly DocumentTypeView[];
  read: PagesRead | null;
  onSaved: (doc: DocumentView) => void;
  onStale: () => Promise<void>;
  onGone: () => void;
}) {
  const { doc, read } = props;
  const { withToken, session } = useApp();
  const household = session.info?.household_id;
  const member = session.info?.member_id;
  const versionId = read?.versionId ?? null;
  const keyed = household && member && versionId ? notNowKey(household, member, versionId) : null;
  const [putAway, setPutAway] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<
    (ReviewToast & { versionId: string; documentId: string }) | null
  >(null);
  const [heard, setHeard] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const errorNote = useRef<HTMLParagraphElement>(null);
  const focusToast = useRef(false);

  useEffect(() => {
    if (!focusToast.current) return;
    focusToast.current = false;
    if (toast) box.current?.focus();
    else errorNote.current?.focus();
  });

  const type = props.types.find((t) => t.key === doc.type_key);
  const word = (key: 'issued' | 'expires' | 'identifier', fallback: string) =>
    coreRule(type, key).label ?? fallback;
  const fieldName: Record<RenewalField, string> = {
    issued: word('issued', 'Issued'),
    expires: word('expires', 'Expires'),
    identifier: word('identifier', 'Number'),
    issued_by: issuedByLabel(type),
  };
  // Only the newest version's pages, only while its details are the version before's.
  const offers: RenewalOffer[] =
    read && versionId === doc.latest_version_id && doc.details_unconfirmed === true
      ? renewalOffers(doc, read.renewal)
      : [];
  const ticked = (o: RenewalOffer) => ticks[`${versionId}:${o.field}`] ?? !o.weak;
  const chosen = offers.filter(ticked);
  const away = putAway === versionId || saidNotNow(keyed);
  const shown = offers.length > 0 && !away;

  const use = async () => {
    if (!versionId || chosen.length === 0 || busy) return;
    const body: RenewalInput = { version_id: versionId };
    for (const o of chosen) Object.assign(body, { [o.field]: o.value });
    setBusy(true);
    setError(null);
    try {
      const done = await withToken((t) => api.applyRenewal(t, doc.id, body, doc.etag));
      if (!done) return;
      const text = `The new version’s details are saved. You can undo this for ${RENEWAL_UNDO_MINUTES} minutes.`;
      setToast({
        text,
        more: [],
        undo: done.undo_until ? { batchId: '', itemIds: [], until: done.undo_until } : null,
        busy: false,
        versionId,
        documentId: doc.id,
      });
      setHeard(text);
      focusToast.current = true;
      props.onSaved(done.document);
    } catch (err) {
      focusToast.current = true;
      if (
        err instanceof ApiRequestError &&
        (err.code === 'conflict' || err.code === 'version_changed')
      ) {
        setError(
          'This document was changed somewhere else, so nothing was saved and it has been loaded again. Check what the new version says against it.',
        );
        await props.onStale();
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!toast || toast.busy) return;
    setToast({ ...toast, busy: true, more: [] });
    try {
      const back = await withToken((t) => api.undoRenewal(t, toast.documentId, toast.versionId));
      if (!back) return;
      const text = 'Undone: the details are as they were.';
      setToast({ ...toast, text, more: [], undo: null, busy: false });
      setHeard(text);
      box.current?.focus();
      props.onSaved(back);
    } catch (err) {
      const why = describeError(err);
      // Kept by the vault: said, and nothing left to undo.
      const kept =
        err instanceof ApiRequestError &&
        (err.code === 'renewal_kept' || err.code === 'renewal_not_undoable');
      setToast({ ...toast, more: [why], busy: false, ...(kept ? { undo: null } : {}) });
      setHeard(why);
      if (kept) await props.onStale();
    }
  };

  return (
    <>
      {toast && (
        <Toast
          toast={toast}
          box={box}
          inline
          onUndo={() => void undo()}
          onDismiss={() => {
            setToast(null);
            props.onGone();
          }}
        />
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {heard}
      </p>
      {error && !shown && (
        <p className="error" role="alert" tabIndex={-1} ref={errorNote}>
          {error}
        </p>
      )}
      {shown && (
        <section className="card sugg-card renewal-card" aria-labelledby="renewal-h">
          <h2 id="renewal-h" className="sugg-h">
            The new version says:
          </h2>
          <p className="muted">
            Its details are still the version before’s. Tick what is right, then Use these: nothing
            changes until you do.
          </p>
          <ul className="renewal-rows">
            {offers.map((o) => (
              <li key={o.field}>
                <label className="renewal-choice">
                  <input
                    type="checkbox"
                    checked={ticked(o)}
                    disabled={busy}
                    onChange={(e) =>
                      setTicks((t) => ({ ...t, [`${versionId}:${o.field}`]: e.target.checked }))
                    }
                  />
                  <span className="renewal-words">
                    <strong>{fieldName[o.field]}</strong> {valueWords(o)}{' '}
                    <span className="muted">
                      (was {valueWords({ field: o.field, value: o.was })})
                    </span>
                    {o.weak && <span className="mark-check">check this</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {error && (
            <p className="error" role="alert" tabIndex={-1} ref={errorNote}>
              {error}
            </p>
          )}
          <div className="row renewal-actions">
            <Button disabled={busy || chosen.length === 0} onClick={() => void use()}>
              {busy ? 'Saving…' : 'Use these'}
            </Button>
            <Button
              kind="quiet"
              disabled={busy}
              onClick={() => {
                setPutAway(versionId);
                try {
                  if (keyed) localStorage.setItem(keyed, '1');
                } catch {
                  // Kept for this visit only, then.
                }
                props.onGone();
              }}
            >
              Not now
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
