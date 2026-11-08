import {
  formatDate,
  issuedByLabel,
  localToday,
  type CoreField,
  type DocumentTypeView,
  type VersionView,
} from '@fdv/shared';
import { Fragment, useEffect, useRef } from 'react';
import { asksFor, coreRule, detailText } from './details.js';
import { familyZoneNow } from './family-time.js';

/**
 * An older version of a document, looked at (0.9.0; the owner's word: "once
 * a new version exist, I'm unable to see the scanned image/copy of the
 * previous version, it only gives me download option").
 *
 * Its pages in the pages pane, as the current version's are; above the
 * details, a banner saying which it is and when it was replaced, with Back
 * to the current version; and its own details, as they were when a newer
 * version replaced it — or, for one replaced before 0.9.0, that they were
 * never kept. What changes a document — Edit, sharing, who sees it, the
 * Trash — is the current version's, so the page offers none of it here.
 */

/** "6 Nov 2026": the day a version was replaced, on the family's calendar. */
export function replacedOn(next: VersionView | undefined): string | null {
  if (!next) return null;
  return formatDate({
    date: localToday(familyZoneNow(), new Date(next.uploaded_at)),
    precision: 'day',
  });
}

/** "Version 1 of 2: replaced on 6 Nov 2026 — not the current version", and the way back. */
export function OlderVersionBanner(props: {
  version: VersionView;
  /** How many versions the document has. */
  of: number;
  /** The version after it: when it was replaced. */
  next: VersionView | undefined;
  onBack: () => void;
}) {
  const { version } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  // Said and given the focus as it is shown: the page changed under the person.
  useEffect(() => {
    heading.current?.focus();
  }, [version.id]);
  const when = replacedOn(props.next);
  return (
    <section className="version-banner" aria-labelledby="version-banner-h">
      <h2 id="version-banner-h" className="version-banner-h" tabIndex={-1} ref={heading}>
        Version {version.version_no} of {props.of}
        {when ? `: replaced on ${when}` : ''} — not the current version
      </h2>
      <p className="muted">
        Its pages and its own details, as they were. Changes are made to the current version.
      </p>
      <button type="button" className="btn btn-quiet version-back" onClick={props.onBack}>
        Back to the current version
      </button>
    </section>
  );
}

/**
 * An older version's own details, as they were when a newer one replaced
 * it, under the kind and person every version shares.
 */
export function OlderVersionDetails(props: {
  version: VersionView;
  type: DocumentTypeView | undefined;
  person: string | null;
}) {
  const { version, type } = props;
  const d = version.details ?? null;
  const word = (key: CoreField, fallback: string) => coreRule(type, key).label ?? fallback;
  const typeFields = (type?.fields ?? []).filter(asksFor);
  const extra = d?.extra ?? {};
  const own = typeFields.flatMap((field) => {
    const value = extra[field.key];
    return value === undefined || value === null || value === '' ? [] : [{ field, value }];
  });
  const others = Object.entries(extra).filter(
    ([key, value]) => value !== null && value !== '' && !typeFields.some((f) => f.key === key),
  );
  return (
    <section aria-labelledby="version-details-h" className="version-details">
      <h2 id="version-details-h" className="section-h">
        This version’s details
      </h2>
      {!d ? (
        <p className="muted">
          {version.details_kept === false
            ? 'Details weren’t kept for versions replaced before 0.9.0. Its pages are as they were.'
            : 'This version’s details were not kept.'}
        </p>
      ) : (
        <>
          {version.details_unconfirmed && (
            <p className="muted">
              These were copied from the version before it and never confirmed for this one.
            </p>
          )}
          <dl className="facts">
            <dt>Type</dt>
            <dd>{type?.label ?? 'Not set'}</dd>
            <dt>Person</dt>
            <dd>{props.person ?? 'Not set'}</dd>
            {d.issued_by && (
              <>
                <dt>{issuedByLabel(type)}</dt>
                <dd>{d.issued_by}</dd>
              </>
            )}
            {d.identifier && (
              <>
                <dt>{word('identifier', 'Number')}</dt>
                <dd>{d.identifier}</dd>
              </>
            )}
            {d.issued && (
              <>
                <dt>{word('issued', 'Issued')}</dt>
                <dd>{formatDate(d.issued)}</dd>
              </>
            )}
            {d.expires && (
              <>
                <dt>{word('expires', 'Expires')}</dt>
                <dd>{formatDate(d.expires)}</dd>
              </>
            )}
            {own.map(({ field, value }) => (
              <Fragment key={field.key}>
                <dt>{field.label}</dt>
                <dd className={field.kind === 'long_text' ? 'keep-lines' : undefined}>
                  {detailText(field.kind, value)}
                </dd>
              </Fragment>
            ))}
            {others.map(([key, value]) => (
              <Fragment key={key}>
                <dt>{key}</dt>
                <dd>{detailText(undefined, value)}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
