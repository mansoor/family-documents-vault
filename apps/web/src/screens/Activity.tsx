import { whenExactly, whenWords, type ActivityLine } from '@fdv/shared';
import { useState } from 'react';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { BottomNav, Button, ErrorNote, TopBar } from '../ui.js';

/**
 * The household activity log (SHR-07).
 *
 * *Sarah downloaded "Home insurance policy" — yesterday, 4:12pm.* This is
 * what makes a shared vault trustworthy between adults: not restrictions,
 * but visibility. So it is a table of sentences and exactly when (5.1), and
 * nothing else — no filters, no event types, no ids.
 */
export function ActivityScreen() {
  const { withToken, authVersion } = useApp();
  // The first page comes from the usual loader; "show older" appends,
  // which is the only reason this screen keeps any state of its own.
  const { data, error: loadError, loading } = useLoad((t) => api.activity(t), [authVersion]);
  const [older, setOlder] = useState<ActivityLine[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = [...(data?.items ?? []), ...older];
  const next = cursor ?? data?.next ?? null;

  const more = async (before: number) => {
    setBusy(true);
    try {
      const page = await withToken((t) => api.activity(t, before));
      if (page) {
        setOlder((old) => [...old, ...page.items]);
        setCursor(page.next);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page-top has-nav">
      <TopBar title="What has been happening" back="/settings" />
      <ErrorNote message={error ?? loadError} />
      <p className="muted">
        Everything anybody has done in this vault. Your own private documents are only ever in your
        copy of this list.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What happened</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className={l.notable ? 'notable' : undefined}>
              <td className="when">
                <time dateTime={l.at} title={whenWords(l.at)}>
                  {whenExactly(l.at)}
                </time>
              </td>
              <td>{l.text}</td>
            </tr>
          ))}
          {!loading && lines.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">
                Nothing yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {next !== null && (
        <Button kind="quiet" disabled={busy} onClick={() => void more(next)}>
          {busy ? 'Loading…' : 'Show older'}
        </Button>
      )}
      <BottomNav />
    </main>
  );
}
