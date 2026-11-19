import { documentActivityEmptyWords, documentActivityWords, type ActivityLine } from '@fdv/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { useFamilyZone } from './family-time.js';
import { chipLower, What, When } from './screens/Activity.js';
import { Button, ErrorNote, LoadFailed } from './ui.js';

/**
 * A document's own activity, in its Activity panel under the row of
 * actions (0.9.0-dev.67, the owner's feedback of 18 Nov 2026): the lines
 * the Activity page shows for it — the same lines, in the same words, a
 * sensitive document never named — newest first, "Show older" for more,
 * and "See all activity" for the Activity page filtered to it. Only for
 * whoever reads the activity log (`audit.read`); the page that draws the
 * panel decides that.
 */
export function DocumentActivityPanel(props: {
  documentId: string;
  title: string | null;
  sensitive: boolean;
}) {
  const { withToken, authVersion } = useApp();
  const timezone = useFamilyZone();
  const ids = useId();
  const { data, error, loading, reload } = useLoad(
    async (t) => ({ of: props.documentId, page: await api.documentActivity(t, props.documentId) }),
    [authVersion, props.documentId],
  );
  // Only this document's: a page loaded for one shown before is none of it.
  const page = data?.of === props.documentId ? data.page : null;
  const [older, setOlder] = useState<{ of: string; lines: ActivityLine[]; next: number | null }>({
    of: '',
    lines: [],
    next: null,
  });
  const mine = older.of === props.documentId;
  const lines = [...(page?.items ?? []), ...(mine ? older.lines : [])];
  const next = mine ? older.next : (page?.next ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const more = async (before: number) => {
    const of = props.documentId;
    setBusy(true);
    setProblem(null);
    try {
      const got = await withToken((t) => api.documentActivity(t, of, before));
      if (got) {
        setOlder((o) => ({
          of,
          lines: [...(o.of === of ? o.lines : []), ...got.items],
          next: got.next,
        }));
      }
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // As the Activity page's chip says it: "About ‘Passport’", or "About a
  // sensitive document" — never its title.
  const about = chipLower(
    documentActivityWords({ title: props.title, sensitive: props.sensitive }),
  );
  return (
    <section className="doc-activity" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`} className="section-h">
        Activity
      </h2>
      {error && !page ? (
        <LoadFailed message={error} what="this document’s activity" onRetry={() => void reload()} />
      ) : loading && !page ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : lines.length === 0 ? (
        <p className="muted">{documentActivityEmptyWords(next !== null)}</p>
      ) : (
        <ul
          className="doc-activity-lines"
          aria-label={`What has been happening, ${about}, newest first`}
        >
          {lines.map((l) => (
            <li key={l.id} className={l.notable ? 'notable' : undefined}>
              <span className="doc-activity-what">
                <What line={l} />
              </span>
              <span className="muted doc-activity-when">
                <When at={l.at} timezone={timezone ?? null} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote message={problem} />
      <div className="row doc-activity-foot">
        {next !== null && (
          <Button kind="quiet" disabled={busy} onClick={() => void more(next)}>
            {busy ? 'Loading…' : 'Show older'}
          </Button>
        )}
        <Link
          className="btn btn-link"
          to={`/activity?document=${encodeURIComponent(props.documentId)}`}
        >
          See all activity
        </Link>
      </div>
    </section>
  );
}
