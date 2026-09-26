import { can } from '@fdv/shared';
import { useState } from 'react';
import { api, type CreatedShare, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ErrorNote, Field } from '../ui.js';

/**
 * Sharing one document with somebody outside the family (SHR-05).
 *
 * The whole feature is one link with an expiry, so the interface is one
 * button and one card. The card has to carry three things the person
 * needs to believe: it stops working on a date, it can be taken back, and
 * every time somebody opens it the family will see.
 */
export function SharePanel(props: {
  documentId: string;
  documentTitle: string | null;
  /**
   * Opened from a row's ⋯ (5.4): it starts at the form, and Cancel or Done
   * closes the sheet it is in.
   */
  onClose?: () => void;
}) {
  const { guarded, authVersion } = useApp();
  const [made, setMade] = useState<CreatedShare | null>(null);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('7');
  const [withPin, setWithPin] = useState(false);
  const [open, setOpen] = useState(Boolean(props.onClose));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, reload } = useLoad(
    async (t) => (await api.shares(t)).items.filter((s) => s.document_id === props.documentId),
    [props.documentId, authVersion],
  );
  if (!can(storedRole(), 'document.share')) return null;

  const active = (data ?? []).filter((s) => s.state === 'active');

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await guarded((t) =>
        api.share(t, props.documentId, {
          ...(label.trim() ? { recipient_label: label.trim() } : {}),
          expires_in_days: Number(days) || 7,
          with_pin: withPin,
        }),
      );
      if (created) {
        setMade(created);
        setOpen(false);
        setLabel('');
        await reload();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (s: Share) => {
    try {
      await guarded((t) => api.revokeShare(t, s.id));
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };

  if (made) {
    return (
      <HandOver
        created={made}
        onDone={() => {
          setMade(null);
          props.onClose?.();
        }}
      />
    );
  }

  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>Send this to someone outside the family</h2>
      <ErrorNote message={error} />

      {active.length > 0 && (
        <ul className="list">
          {active.map((s) => (
            <li key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{s.summary}</span>
              <Button kind="quiet" onClick={() => void revoke(s)}>
                Take it back
              </Button>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <div className="stack">
          <Field
            id="share-label"
            label="Who is it for?"
            value={label}
            onChange={setLabel}
            required={false}
            hint="Only for your own list — the letting agent, the accountant. They never see it."
          />
          <Field
            id="share-days"
            label="Stops working after"
            type="number"
            value={days}
            onChange={setDays}
            hint="Days. Seven is usually enough."
          />
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={withPin}
              onChange={(e) => setWithPin(e.target.checked)}
            />
            <span>Also ask for a four-digit PIN, which you tell them separately</span>
          </label>
          <div className="row">
            <Button disabled={busy} onClick={() => void create()}>
              {busy ? 'Making the link…' : 'Make the link'}
            </Button>
            <Button kind="quiet" onClick={() => (props.onClose ? props.onClose() : setOpen(false))}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button kind="quiet" onClick={() => setOpen(true)}>
          Share a link
        </Button>
      )}
    </section>
  );
}

function HandOver(props: { created: CreatedShare; onDone: () => void }) {
  const link = `${window.location.origin}/shared/${props.created.link_token}`;
  const [copied, setCopied] = useState(false);
  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>
        The link to {props.created.share.document_title ?? 'this document'}
      </h2>
      <code style={{ wordBreak: 'break-all' }}>{link}</code>
      <Button
        kind="quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(link).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'Copied' : 'Copy the link'}
      </Button>
      {props.created.pin && (
        <div className="field">
          <span className="field-label">The PIN</span>
          <code style={{ fontSize: 24, letterSpacing: 4 }}>{props.created.pin}</code>
          <span className="muted">
            Tell them this some other way — a phone call, not the same message.
          </span>
        </div>
      )}
      <p className="muted">
        Anyone with the link can open this one document until it expires, and nothing else. You will
        see every time it is opened, and you can take it back whenever you like.
      </p>
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}
