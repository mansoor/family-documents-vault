import {
  ONLY_ME_KIND,
  READING_CHECK_N,
  readingComparison,
  type DocumentTypeView,
  type ReadingCheckDetail,
  type ReadingCheckOther,
  type ReadingCheckView,
  type ReadingCounts,
  type ReadingResult,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, Check, ConfirmDialog, ErrorNote, Field, LoadFailed } from './ui.js';
import { dayWordsOf, familyZoneNow, shortWhenWords } from './family-time.js';

/**
 * The Reading check (0.9.0, R0): an owner's, the second part of Settings →
 * Server and reading → Reading and the check, that measures the vault's reader on the family's own papers.
 *
 * An owner starts a check of the last N documents filed through review;
 * the worker reads them again in the background, and the page shows how far
 * it has got (a progress bar, polled while it runs) and lets any owner
 * cancel it. A finished check shows its numbers — read without the learned
 * rules, and with "your learning, on the documents you filed", which is
 * optimistic — by kind, and against the check before it ("Since
 * 0.9.0-dev.2: needs typing 18 → 11"), and lists the documents that needed
 * typing and what, for seven days. A check is its owner's alone: another
 * owner is told only that one of theirs is running or finished, and whose
 * — so that one at a time makes sense — never its numbers.
 */

/** How often the page asks again while a check waits or runs. */
export const READING_POLL_MS = 3_000;

const running = (c: Pick<ReadingCheckView, 'state'>) =>
  c.state === 'waiting' || c.state === 'running';

/** "17 Oct, 14:03", on the family's clock (0.9.0, TZ). */
function whenWords(at: string): string {
  return shortWhenWords(at, familyZoneNow());
}

const FIELD_WORDS = { kind: 'the kind', person: 'whose it is', expiry: 'the expiry' } as const;

/** "the kind and whose it is". */
function fieldsWords(fields: ReadonlyArray<keyof typeof FIELD_WORDS>): string {
  const w = fields.map((f) => FIELD_WORDS[f]);
  return w.length <= 1 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`;
}

/** What a finished, failed or cancelled check says of itself, in a line. */
function stateWords(c: ReadingCheckView): string {
  switch (c.state) {
    case 'waiting':
      return 'Waiting for the vault to start reading…';
    case 'running':
      return `Reading ${c.progress.done} of ${c.progress.total}…`;
    case 'cancelled':
      return `Cancelled after ${c.progress.done} of ${c.progress.total}.`;
    case 'failed':
      return c.failure === 'restored'
        ? 'Stopped when the vault was restored from a backup.'
        : 'Stopped: whoever started it can no longer run checks.';
    default:
      return c.summary
        ? `${c.summary.without_rules.all.needs_typing} of ${c.summary.read} needed typing.`
        : 'Done.';
  }
}

export function ReadingCheckPart() {
  const { authVersion, guarded } = useApp();
  const { data, error, reload } = useLoad((t) => api.readingChecks(t), [authVersion]);
  const kinds = useLoad((t) => api.documentTypes(t, { all: true }), [authVersion]);
  const [n, setN] = useState(String(READING_CHECK_N.default));
  const [edited, setEdited] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /** The one status region takes focus only after something the reader did. */
  const focusSaid = useRef(false);
  const say = (words: string | null, focus = false) => {
    focusSaid.current = focus;
    setSaid(words);
  };
  const [shownId, setShownId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ReadingCheckView | null>(null);
  const line = useRef<HTMLParagraphElement>(null);

  const items = data?.items ?? [];
  const others = data?.others ?? [];
  const current = items.find(running) ?? null;
  // Somebody else's, waiting or running: one at a time, so none can start.
  const theirs = current ? null : (others.find(running) ?? null);
  const done = items.filter((c) => c.state === 'done');
  const shown = items.find((c) => c.id === shownId && c.state === 'done') ?? done[0] ?? null;

  // While one waits or runs, theirs or somebody else's, asked again now and then.
  const busyNow = current ?? theirs;
  useEffect(() => {
    if (!busyNow) return;
    const t = setTimeout(() => void reload(), READING_POLL_MS);
    return () => clearTimeout(t);
  }, [busyNow, data, reload]);
  useEffect(() => {
    if (said && focusSaid.current) line.current?.focus();
  }, [said]);
  // Said in the one status region as its state changes — never as each
  // poll moves the count on (the R0 review).
  const was = useRef<{ mine: ReadingCheckView | null; theirs: ReadingCheckOther | null } | null>(
    null,
  );
  useEffect(() => {
    if (!data) return;
    const before = was.current;
    was.current = { mine: current, theirs };
    if (!before) return;
    if (before.mine && before.mine.id !== current?.id) {
      const now = items.find((c) => c.id === before.mine?.id);
      if (now?.state === 'done' && now.summary) {
        say(
          `The check has finished: ${now.summary.without_rules.all.needs_typing} of ${now.summary.read} needed typing.`,
        );
      } else if (now?.state === 'failed') {
        say('The check stopped before it finished.');
      }
    } else if (before.mine?.state === 'waiting' && current?.state === 'running') {
      say('The vault has started reading.');
    } else if (before.theirs && !theirs && !current) {
      say(
        `${before.theirs.requested_by.name ?? 'The other'}’s check has finished. You can start yours.`,
      );
    }
    // Only what changed is said: the poll's own data, and nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const number = Number(n);
  const nValid =
    /^\d+$/.test(n.trim()) && number >= READING_CHECK_N.min && number <= READING_CHECK_N.max;

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !nValid) return;
    setBusy(true);
    setActionError(null);
    say(null);
    try {
      const made = await guarded((t) =>
        api.startReadingCheck(t, { n: number, include_edited: edited }),
      );
      if (made !== null) {
        // Said by this, not again by the poll.
        was.current = { mine: made, theirs: null };
        await reload();
        say('Started. The vault reads them in the background; you can leave this page.', true);
      }
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (c: ReadingCheckView) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    say(null);
    try {
      const gone = await guarded((t) => api.cancelReadingCheck(t, c.id));
      if (gone !== null) {
        was.current = { mine: null, theirs: null };
        await reload();
        say('Cancelled. Nothing it read was kept.', true);
      }
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: ReadingCheckView) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const gone = await guarded((t) => api.deleteReadingCheck(t, c.id));
      if (gone !== null) {
        setRemoving(null);
        await reload();
        say('Removed.', true);
      }
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const labelOf = (key: string) =>
    key === ONLY_ME_KIND
      ? 'Your Only me documents'
      : key === '(none)'
        ? 'Something else'
        : (kinds.data?.items.find((k: DocumentTypeView) => k.key === key)?.label ??
          // A kind not given here (removed since): its key, in words.
          key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));

  return (
    <>
      <p className="lede">
        See how well the vault reads your family’s own papers. It reads again the last documents
        someone filed through review, where a person checked the details, and counts how often it
        would have got them right. Nothing leaves the vault, nothing is changed, and only the
        numbers are kept.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="the Reading check" onRetry={() => void reload()} />
      ) : data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {current ? (
            <section aria-labelledby="reading-now-h" className="stack">
              <h3 id="reading-now-h" className="section-h">
                Reading now
              </h3>
              <p>{stateWords(current)}</p>
              <progress
                className="reading-progress"
                aria-label="Documents read"
                max={Math.max(current.progress.total, 1)}
                value={current.progress.done}
              />
              <p className="muted">
                Started {whenWords(current.created_at)}. It runs behind everything else the vault is
                doing, so it can take a while.
              </p>
              <div className="row">
                <Button kind="quiet" disabled={busy} onClick={() => void cancel(current)}>
                  Cancel the check
                </Button>
              </div>
            </section>
          ) : theirs ? (
            <section aria-labelledby="reading-now-h" className="stack">
              <h3 id="reading-now-h" className="section-h">
                Reading now
              </h3>
              <p>
                {`${theirs.requested_by.name ?? 'Another owner'}’s check is ${
                  theirs.state === 'waiting' ? 'waiting to start' : 'running'
                }. One check runs at a time: you can start yours once it has finished.`}
              </p>
            </section>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => void start(e)}
              aria-labelledby="reading-start-h"
            >
              <h3 id="reading-start-h" className="section-h">
                Start a check
              </h3>
              {data.filed === 0 ? (
                <p className="attention">
                  No documents have been filed through review yet. Add some with{' '}
                  <Link to="/add/many">Many documents</Link>, check their details and accept them,
                  then come back.
                </p>
              ) : (
                <p className="muted">
                  {data.filed === 1
                    ? 'You can see 1 document filed through review.'
                    : `You can see ${data.filed} documents filed through review.`}
                </p>
              )}
              <Field
                id="reading-n"
                label="Read again the last"
                type="number"
                inputMode="numeric"
                value={n}
                invalid={!nValid}
                onChange={setN}
                note={`documents filed through review: from ${READING_CHECK_N.min} to ${READING_CHECK_N.max}.`}
              />
              <Check
                id="reading-edited"
                checked={edited}
                onChange={setEdited}
                label="Include documents changed by hand since they were filed"
                note="Their details now count as right."
              />
              <div className="row">
                <Button kind="primary" type="submit" disabled={busy || !nValid || data.filed === 0}>
                  Start the check
                </Button>
              </div>
            </form>
          )}
          <ErrorNote message={actionError} />
          <p ref={line} className="status-line" role="status" tabIndex={-1}>
            {said}
          </p>
          {shown && (
            <Result
              check={shown}
              earlier={done[done.indexOf(shown) + 1] ?? null}
              labelOf={labelOf}
              onRemove={() => setRemoving(shown)}
              busy={busy}
            />
          )}
          {items.length + others.length > 0 && (
            <section aria-labelledby="reading-all-h" className="stack">
              <h3 id="reading-all-h" className="section-h">
                Checks
              </h3>
              <ul className="list reading-list">
                {items.map((c) => (
                  <li key={c.id} className="reading-row">
                    <span>
                      <span className="doc-title">{whenWords(c.created_at)}</span>
                      <span className="muted">
                        {[
                          c.reader.server_version ? `Server ${c.reader.server_version}` : null,
                          c.requested_by.name ? `by ${c.requested_by.name}` : null,
                          stateWords(c),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {c.state === 'done' && c.id !== shown?.id && (
                      <Button
                        kind="quiet"
                        onClick={() => setShownId(c.id)}
                        ariaLabel={`Show the check of ${whenWords(c.created_at)}`}
                      >
                        Show
                      </Button>
                    )}
                  </li>
                ))}
                {others.map((o, i) => (
                  <li key={`other-${i}`} className="reading-row">
                    <span>
                      <span className="doc-title">
                        {`${o.requested_by.name ?? 'Another owner'}’s check`}
                      </span>
                      <span className="muted">
                        {`${
                          running(o) ? 'Running' : o.state === 'done' ? 'Finished' : 'Stopped'
                        } · only they see what it found`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {removing && (
        <ConfirmDialog
          title="Remove this check?"
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        >
          Its numbers go, and so does its list of documents that needed typing. Your documents are
          not touched.
        </ConfirmDialog>
      )}
    </>
  );
}

/** A finished check: its numbers, how they compare, by kind, and — for its owner — its misses. */
function Result(props: {
  check: ReadingCheckView;
  earlier: ReadingCheckView | null;
  labelOf: (key: string) => string;
  onRemove: () => void;
  busy: boolean;
}) {
  const { check, earlier } = props;
  const { authVersion } = useApp();
  const detail = useLoad(
    (t): Promise<ReadingCheckDetail | null> =>
      check.mine ? api.readingCheck(t, check.id) : Promise.resolve(null),
    [authVersion, check.id, check.mine],
  );
  const s = check.summary;
  if (!s) return null;
  const compared = earlier ? readingComparison(earlier, check) : null;
  const misses = detail.data?.misses ?? null;
  return (
    <section aria-labelledby="reading-result-h" className="stack">
      <h3 id="reading-result-h" className="section-h">
        {`Checked ${whenWords(check.finished_at ?? check.created_at)}`}
      </h3>
      <p>
        <strong>{`${s.without_rules.all.needs_typing} of ${s.read}`}</strong> needed something
        typed; <strong>{s.without_rules.all.wrong_ready}</strong>{' '}
        {s.without_rules.all.wrong_ready === 1 ? 'was' : 'were'} Ready but wrong.
        {check.reader.server_version ? ` Server ${check.reader.server_version}.` : ''}
      </p>
      {compared && <p className="attention attention-calm">{compared}.</p>}
      {(s.skipped > 0 || s.edited > 0) && (
        <p className="muted">
          {[
            s.skipped > 0
              ? `${s.skipped} left out: removed, moved to the Trash or no longer yours to see while it ran`
              : null,
            s.edited > 0 ? `${s.edited} changed by hand since they were filed` : null,
          ]
            .filter(Boolean)
            .join('; ')}
          .
        </p>
      )}
      <div className="table-scroll">
        <table className="data-table reading-table">
          <caption className="visually-hidden">How the vault read them</caption>
          <thead>
            <tr>
              <th scope="col">Documents</th>
              <th scope="col">Without learned rules</th>
              <th scope="col">With your learning</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, key]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td>{s.without_rules.all[key]}</td>
                <td>{s.with_rules.all[key]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        With your learning: the rules the vault learned from your corrections, on the documents you
        filed; on anybody else’s it is the same as without. It is optimistic, since the rules were
        learned from these same papers. Without them is the honest number.
      </p>
      <ByKind result={s.without_rules} labelOf={props.labelOf} />
      {check.mine ? (
        misses === null ? (
          detail.data && <p className="muted">The list of documents that needed typing has gone.</p>
        ) : misses.length === 0 ? (
          <p className="muted">None of the documents you can see needed typing.</p>
        ) : (
          <section aria-labelledby="reading-misses-h" className="stack">
            <h4 id="reading-misses-h">Documents that needed typing</h4>
            <p className="muted">
              Only you see this list
              {detail.data?.misses_until
                ? `, until ${dayWordsOf(detail.data.misses_until, familyZoneNow(), { month: 'short' })}`
                : ''}
              .
            </p>
            <ul className="list">
              {misses.map((m) => (
                <li key={m.document_id}>
                  <Link to={`/documents/${m.document_id}`} className="rowbtn">
                    <span className="doc-title">{m.title ?? 'Untitled'}</span>
                    <span className="muted">
                      {`Needed ${fieldsWords(m.fields)}`}
                      {m.wrong_ready ? '; it was Ready but wrong' : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : (
        <p className="muted">
          {check.requested_by.name
            ? `Only ${check.requested_by.name}, who ran it, sees which documents needed typing.`
            : 'Only the owner who ran it sees which documents needed typing.'}
        </p>
      )}
      <div className="row">
        <Button kind="quiet" danger disabled={props.busy} onClick={props.onRemove}>
          Remove this check
        </Button>
      </div>
    </section>
  );
}

const ROWS: Array<[string, keyof ReadingCounts]> = [
  ['Read', 'documents'],
  ['Ready', 'ready'],
  ['Check', 'check'],
  ['Not recognised', 'unrecognised'],
  ['Could not be read', 'not_read'],
  ['Needed typing', 'needs_typing'],
  ['Ready but wrong', 'wrong_ready'],
];

function ByKind({ result, labelOf }: { result: ReadingResult; labelOf: (key: string) => string }) {
  const rows = Object.entries(result.by_kind).sort(
    ([a, x], [b, y]) => y.documents - x.documents || a.localeCompare(b),
  );
  if (rows.length === 0) return null;
  return (
    <div className="table-scroll">
      <table className="data-table reading-table">
        <caption className="reading-caption">By kind, without learned rules</caption>
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Documents</th>
            <th scope="col">Kind right</th>
            <th scope="col">Nothing to type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, r]) => (
            <tr key={k}>
              <th scope="row">{labelOf(k)}</th>
              <td>{r.documents}</td>
              <td>{r.kind_right}</td>
              <td>{r.no_typing}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
