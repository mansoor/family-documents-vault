import {
  shareEndWords,
  visibilityChoices,
  type LinksChoiceNeeded,
  type OwnLinkToEnd,
  type Visibility,
} from '@fdv/shared';
import { useState } from 'react';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ConfirmDialog, ErrorNote, Pills } from '../ui.js';

/**
 * Who can see a document, in the three plain choices the design insists
 * on — and the sentence that has to be said when somebody picks the third
 * one (SEC-19).
 *
 * "Only you can open this. Nobody can open it after you, unless you leave
 * a key." It is a message about death, so it is brief, plain and
 * unsentimental, it appears at the moment the choice becomes true, and it
 * is never shown for that document again. The server decides whether it
 * has been said before; this screen only shows what it is given.
 */

const CHOICES: Array<{ value: Visibility; label: string; hint: string }> = [
  {
    value: 'household',
    label: 'Everyone in the family',
    hint: 'Anybody with a sign-in here can open it.',
  },
  { value: 'adults', label: 'Adults only', hint: 'The teens and viewers will not see it.' },
  { value: 'private', label: 'Only me', hint: 'Nobody else, including the owner of this vault.' },
];

export function VisibilityControl(props: {
  documentId: string;
  current: Visibility;
  isMine: boolean;
  /** Whether the reader filed it: a teen changes only the ones they filed (A72). */
  filedByMe: boolean;
  onChanged: () => Promise<void>;
  /**
   * Opened from a row's ⋯ (5.4): it starts at the choice, and Cancel, a
   * save, or "I understand" closes the sheet it is in.
   */
  onClose?: () => void;
  /**
   * A change is being saved. The sheet it is in stays open until it is
   * done: the vault says "Only you can open this" once, and only here.
   */
  onBusy?: (busy: boolean) => void;
}) {
  const { guarded, withToken } = useApp();
  const [open, setOpen] = useState(Boolean(props.onClose));
  // Into Only me with links of one's own (5.41): which, and whether they
  // may be kept, as the vault said; and what was chosen — End, unless Keep.
  const [ask, setAsk] = useState<
    (LinksChoiceNeeded & { message: string; timezone: string }) | null
  >(null);
  const [keep, setKeep] = useState(false);
  const [choice, setChoice] = useState<Visibility>(props.current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  // What this reader may change it to (visibilityChoices, @fdv/shared):
  // making something private, or taking it back, belongs to the person it
  // is about, so the button does not pretend; a teen, on their own that
  // they filed, has Only me and Everyone (A72); nothing to choose, no button.
  const allowed = visibilityChoices(
    { role: storedRole(), mine: props.isMine, filedByMe: props.filedByMe },
    props.current,
  );
  if (allowed.length === 0) return null;
  const choices = CHOICES.filter((c) => allowed.includes(c.value));

  const working = (on: boolean) => {
    setBusy(on);
    props.onBusy?.(on);
  };

  const save = async (ownLinks?: 'end' | 'keep') => {
    working(true);
    setError(null);
    try {
      const result = await guarded((t) => api.setVisibility(t, props.documentId, choice, ownLinks));
      setAsk(null);
      if (!result) return;
      await props.onChanged();
      setOpen(false);
      if (result.notice) setNotice(result.notice);
      else props.onClose?.();
    } catch (err) {
      const asked = linksChoice(err);
      if (asked && !ownLinks) {
        // The links are listed on the household's clock.
        const profile = await withToken((t) => api.profile(t)).catch(() => null);
        setKeep(false);
        setAsk({ ...asked, message: (err as Error).message, timezone: profile?.timezone ?? 'UTC' });
      } else {
        setAsk(null);
        setError(describeError(err));
      }
    } finally {
      working(false);
    }
  };

  if (notice) {
    return (
      <section className="card stack" role="alert" aria-labelledby="private-notice-h">
        <h2 id="private-notice-h" style={{ fontSize: 18 }}>
          {notice.title}
        </h2>
        <p>{notice.body}</p>
        <Button
          onClick={() => {
            setNotice(null);
            props.onClose?.();
          }}
        >
          I understand
        </Button>
      </section>
    );
  }

  if (!open) {
    return (
      <Button kind="link" onClick={() => setOpen(true)}>
        Change who can see this
      </Button>
    );
  }

  return (
    <section className="card stack">
      <Pills
        label="Who can see this"
        value={choice}
        options={choices.map((c) => ({ value: c.value, label: c.label }))}
        onChange={setChoice}
      />
      <p className="muted">{choices.find((c) => c.value === choice)?.hint}</p>
      <ErrorNote message={error} />
      {ask && (
        <ConfirmDialog
          title="Your links to this document"
          confirmLabel="Make it Only me"
          busyLabel="Saving…"
          busy={busy}
          onConfirm={() => void save(keep && ask.keep_allowed ? 'keep' : 'end')}
          onCancel={() => setAsk(null)}
        >
          <p>{ask.message}</p>
          <ul className="stack" aria-label="Your links to it">
            {ask.links.map((l) => (
              <li key={l.id}>{ownLinkWords(l, ask.timezone)}</li>
            ))}
          </ul>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>What happens to them</legend>
            <label className="row" style={{ gap: 8 }}>
              <input
                type="radio"
                name="own-links"
                checked={!keep || !ask.keep_allowed}
                onChange={() => setKeep(false)}
              />
              <span>End these links</span>
            </label>
            {ask.keep_allowed ? (
              <label className="row" style={{ gap: 8 }}>
                <input
                  type="radio"
                  name="own-links"
                  checked={keep}
                  onChange={() => setKeep(true)}
                />
                <span>Keep them: the people they are for can still open it</span>
              </label>
            ) : (
              <p>This household doesn’t share Only me documents outside the family, so they end.</p>
            )}
          </fieldset>
          {ask.others > 0 && (
            <p>
              {ask.others === 1
                ? 'The link someone else made to it stops.'
                : `The ${ask.others} links others made to it stop.`}
            </p>
          )}
        </ConfirmDialog>
      )}
      <div className="row">
        <Button disabled={busy || choice === props.current} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {/* Not while it is being saved: it would be saved, and the notice never shown. */}
        <Button
          kind="quiet"
          disabled={busy}
          onClick={() => (props.onClose ? props.onClose() : setOpen(false))}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}

/** `409 links_choice_needed`, read: the person's own links, and whether keeping them is offered. */
function linksChoice(err: unknown): LinksChoiceNeeded | null {
  if (!(err instanceof ApiRequestError) || err.code !== 'links_choice_needed') return null;
  try {
    const parsed = JSON.parse(err.detail ?? '') as Partial<LinksChoiceNeeded>;
    return Array.isArray(parsed.links)
      ? {
          links: parsed.links,
          keep_allowed: parsed.keep_allowed === true,
          others: Number(parsed.others) || 0,
        }
      : null;
  } catch {
    return null;
  }
}

/** "For the attorney: ends 10 Oct 2026, 5:00 pm; asks for a password." */
export function ownLinkWords(l: OwnLinkToEnd, timezone: string): string {
  const who = l.recipient_label ? `For ${l.recipient_label}` : 'A link';
  const what = l.kind === 'collection' ? ` (the collection “${l.collection_name ?? ''}”)` : '';
  const asks =
    l.protection.length === 0
      ? 'asks for nothing more'
      : `asks for ${l.protection
          .map((p) => (p === 'pin' ? 'a PIN' : p === 'password' ? 'a password' : 'an emailed code'))
          .join(' and ')}`;
  return `${who}${what}: ends ${shareEndWords(new Date(l.expires_at), timezone, { weekday: false })}; ${asks}.`;
}
