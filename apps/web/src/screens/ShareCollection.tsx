import {
  can,
  FOLLOW_MAX_DAYS,
  SHARE_MAX_DAYS,
  type Capabilities,
  type CollectionShareItem,
  type CollectionView,
  type Role,
} from '@fdv/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type CreatedShare } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { Button, ErrorNote, LockIcon } from '../ui.js';
import { HandOver, LinkOptions, readLinkOptions, useLinkOptions } from './Share.js';

/**
 * Sharing a collection outside the family (5.19).
 *
 * The sheet lists the documents in the collection the sharer can see, each
 * with a box. What everybody the collection is for may see is ticked; an
 * adults-only one asks "include anyway?", and the sharer's own private one
 * says so and is never ticked for them. Only what is ticked goes — the rest
 * stays in the family, and nothing tells the other end it is there — and
 * each is checked again every time the link is used. Then a link's options
 * (5.18), and whether it keeps up with the collection: what is put in it
 * later goes too, if everybody it is for may see it, and such a link lasts
 * 30 days at most. Making it always asks to confirm it's you.
 */

/**
 * Whether the reader is offered to share a collection: the vault can
 * (`features.collection_shares`), they may share (owners and adults: a teen
 * never shares a collection outside, A18), and it is not Only me.
 */
export function collectionShareOffered(
  caps: Capabilities | null,
  role: Role,
  collection: Pick<CollectionView, 'audience'>,
): boolean {
  return (
    caps?.features.collection_shares === true &&
    can(role, 'document.share') &&
    collection.audience !== 'only_me'
  );
}

export function ShareCollectionPanel(props: {
  collection: Pick<CollectionView, 'id' | 'name'>;
  onClose: () => void;
  /** A link is being made: the sheet stays open until it is done. */
  onBusy: (busy: boolean) => void;
  /** A link was made: the collection says it is shared now. */
  onShared?: () => void;
}) {
  const { guarded, caps } = useApp();
  const { data, error: loadError } = useLoad(
    async (t) => {
      const [offered, profile] = await Promise.all([
        api.collectionSharePreview(t, props.collection.id),
        api.profile(t).catch(() => null),
      ]);
      return { offered, timezone: profile?.timezone ?? 'UTC' };
    },
    [props.collection.id],
  );
  /** What the sharer has ticked, or unticked, by hand: over what the vault ticked. */
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [follow, setFollow] = useState(false);
  const options = useLinkOptions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<CreatedShare | null>(null);
  // Once what is in it has come, the first box takes the focus: the sheet
  // starts at the top, where the choosing is, not at whatever came first.
  const firstBox = useRef<HTMLInputElement | null>(null);
  const followBox = useRef<HTMLInputElement | null>(null);
  const loaded = data !== null;
  useEffect(() => {
    if (loaded) (firstBox.current ?? followBox.current)?.focus();
  }, [loaded]);

  const items = data?.offered.items ?? [];
  const firstOpen = items.find((i) => i.lock !== 'no_file')?.document_id;
  const isTicked = (i: CollectionShareItem) =>
    i.lock !== 'no_file' && (chosen[i.document_id] ?? i.ticked);
  const ticked = items.filter(isTicked);
  const timezone = data?.timezone ?? 'UTC';
  const vaultMax = caps?.limits.share_max_days ?? SHARE_MAX_DAYS;
  // A link that keeps up with the collection lasts 30 days at most (A19).
  const maxDays = follow ? Math.min(vaultMax, FOLLOW_MAX_DAYS) : vaultMax;
  const viewable = ticked.every((i) => i.viewable);
  const read = readLinkOptions(options.value, { timezone, maxDays, viewable });
  const nothing = ticked.length === 0 && !follow;

  const working = (on: boolean) => {
    setBusy(on);
    props.onBusy(on);
  };

  const make = async () => {
    if (!read.body || nothing) return;
    working(true);
    setError(null);
    try {
      const created = await guarded((t) =>
        api.shareCollection(t, props.collection.id, {
          ...read.body,
          document_ids: ticked.map((i) => i.document_id),
          ...(follow ? { follow_collection: true } : {}),
        }),
      );
      if (created) {
        setMade(created);
        props.onShared?.();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      working(false);
    }
  };

  if (made) {
    return <HandOver created={made} timezone={timezone} onDone={props.onClose} />;
  }

  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>Share “{props.collection.name}” outside the family</h2>
      <p className="muted">
        Only what you tick goes. The rest stays in the family, and nothing tells them it is there.
        Each is checked again whenever the link is used: one you can no longer see, or that leaves
        the collection, stops being sent.
      </p>
      <ErrorNote message={error ?? loadError} />
      {data === null && !loadError && (
        <p className="muted" role="status">
          Finding what is in it…
        </p>
      )}
      {data !== null && (
        <fieldset className="stack share-items">
          <legend className="field-label">What they will see</legend>
          {items.length === 0 && (
            <p className="muted">There is nothing in this collection you can see yet.</p>
          )}
          <ul className="list">
            {items.map((i) => {
              const id = `share-item-${i.document_id}`;
              return (
                <li key={i.document_id} className="share-item">
                  <label
                    htmlFor={id}
                    className="row"
                    style={{ gap: 8, alignItems: 'start', flexWrap: 'nowrap' }}
                  >
                    <input
                      ref={i.document_id === firstOpen ? firstBox : undefined}
                      id={id}
                      type="checkbox"
                      checked={isTicked(i)}
                      disabled={i.lock === 'no_file' || busy}
                      aria-describedby={i.reason ? `${id}-why` : undefined}
                      onChange={(e) =>
                        setChosen((c) => ({ ...c, [i.document_id]: e.target.checked }))
                      }
                    />
                    <span className="stack" style={{ gap: 2 }}>
                      <span>{i.title ?? 'A document'}</span>
                      {i.type_label && <span className="muted">{i.type_label}</span>}
                    </span>
                  </label>
                  {i.reason && (
                    <span
                      id={`${id}-why`}
                      className={`share-item-why muted${i.lock === 'private' ? ' warn' : ''}`}
                    >
                      <LockIcon /> {i.reason}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted" role="status">
            {ticked.length === 0
              ? follow
                ? 'Nothing ticked: only what you put in it from now on will go.'
                : 'Tick at least one document to share.'
              : ticked.length === 1
                ? '1 document ticked.'
                : `${ticked.length} documents ticked.`}
          </p>
        </fieldset>
      )}

      {loaded && (
        <>
          <label className="row" style={{ gap: 8, alignItems: 'start', flexWrap: 'nowrap' }}>
            <input
              ref={followBox}
              type="checkbox"
              checked={follow}
              disabled={busy}
              onChange={(e) => setFollow(e.target.checked)}
              aria-describedby="share-follow-note"
            />
            <span className="stack" style={{ gap: 2 }}>
              <span>Keep it up to date</span>
              <span id="share-follow-note" className="muted">
                What you put in the collection later goes too, if everybody it is for may see it —
                never a private document. A link that keeps up lasts {FOLLOW_MAX_DAYS} days at most.
              </span>
            </span>
          </label>

          <LinkOptions
            options={options}
            read={read}
            timezone={timezone}
            viewable={viewable}
            notViewable="Word and Excel files can only be shared with download: untick them to share the rest to view."
            viewNote="They will see the first 30 pages of each."
          />
          <p className="muted">
            You will be asked to confirm it is you: a collection can say a lot.
          </p>
        </>
      )}
      <div className="row">
        <Button
          disabled={busy || !read.body || nothing || data === null}
          onClick={() => void make()}
        >
          {busy ? 'Making the link…' : 'Make the link'}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
