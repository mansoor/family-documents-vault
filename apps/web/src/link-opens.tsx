import {
  openingWords,
  type DocumentLinkOpening,
  type ShareOpening,
  type ShareOpens,
} from '@fdv/shared';
import { useId, useState } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dateTimeWords } from './family-time.js';
import { storedRole } from './session.js';
import { Button } from './ui.js';

/**
 * Who opened a link, when (0.9.0, H5): a plain list, newest first — the
 * time of each opening and the browser it was opened in, as the vault
 * describes it. Never an address: the activity log shows none either.
 */
export function OpeningsList(props: { opens: ShareOpening[]; label?: string }) {
  if (props.opens.length === 0) return <span className="muted">Not opened yet.</span>;
  return (
    <ul className="link-openings" aria-label={props.label ?? 'Who opened it, when'}>
      {props.opens.map((o, i) => (
        <li key={`${o.at}-${i}`}>{openingWords(o, dateTimeWords(o.at))}</li>
      ))}
    </ul>
  );
}

/**
 * Beside a link in a list (H5): "Who opened it" once it has been opened,
 * its openings fetched only when asked for. Its maker's and an owner's;
 * the vault refuses anybody else, and then nothing is said.
 */
export function LinkOpens(props: {
  link: { id: string; open_count: number; recipient_label: string | null; mine?: boolean };
}) {
  const { caps, withToken } = useApp();
  const [shown, setShown] = useState<ShareOpens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (caps?.features.share_opens !== true || props.link.open_count === 0) return null;
  // Its maker's, and an owner's: nobody else is shown it.
  if (props.link.mine !== true && storedRole() !== 'owner') return null;
  const who = props.link.recipient_label ? ` the link for ${props.link.recipient_label}` : ' it';
  const toggle = async () => {
    if (shown) {
      setShown(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const got = await withToken((t) => api.shareOpens(t, props.link.id));
      if (got) setShown(got);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="stack" style={{ gap: 4 }}>
      <Button
        kind="quiet"
        disabled={busy}
        ariaLabel={shown ? `Hide who opened${who}` : `Who opened${who}, when`}
        onClick={() => void toggle()}
      >
        {shown ? 'Hide who opened it' : `Who opened it (${props.link.open_count})`}
      </Button>
      {error && <span className="field-error">{error}</span>}
      {shown && <OpeningsList opens={shown.items} />}
    </span>
  );
}

/**
 * On a sensitive document's page, for the person it belongs to (H5): every
 * link to it — whoever made it — and who opened each, when. Their health
 * papers went outside the family; who opened them is theirs to know. Links
 * the reader made themselves are in the Share card already, and left out.
 */
export function TheirLinksOpened(props: { documentId: string }) {
  const { caps, authVersion } = useApp();
  const headingId = `${useId()}-h`;
  const on = caps?.features.share_opens === true;
  const { data } = useLoad(
    async (t) =>
      on
        ? api.documentLinkOpens(t, props.documentId).catch(() => ({ items: [] }))
        : { items: [] as DocumentLinkOpening[] },
    [props.documentId, authVersion, on],
  );
  const others = (data?.items ?? []).filter((l) => !l.mine);
  if (others.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby={headingId}>
      <h2 id={headingId} style={{ fontSize: 18 }}>
        Shared outside the family
      </h2>
      <p className="muted">
        This is sensitive and it’s yours, so you can see every link to it and who opened each.
      </p>
      <ul className="list">
        {others.map((l) => (
          <li key={l.share_id} className="stack" style={{ gap: 4 }}>
            <span>
              <strong>{l.recipient_label ?? 'A link'}</strong>
              <span className="muted">
                {' '}
                · made by {l.created_by_name ?? 'somebody who has left'} ·{' '}
                {l.state === 'active'
                  ? `works until ${dateTimeWords(l.expires_at)}`
                  : l.state === 'revoked'
                    ? 'taken back'
                    : 'no longer works'}
              </span>
            </span>
            <OpeningsList
              opens={l.opens}
              label={`Who opened the link${l.recipient_label ? ` for ${l.recipient_label}` : ''}, when`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
