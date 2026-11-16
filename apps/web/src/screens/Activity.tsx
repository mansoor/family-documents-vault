import {
  ACTIVITY_KINDS,
  documentActivityEmptyWords,
  documentActivityWords,
  localToday,
  type ActivityLine,
} from '@fdv/shared';
import { useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { useShellMode } from '../shell.js';
import { FilterSelect } from '../table-grid.js';
import { Button, ErrorNote, TopBar } from '../ui.js';
import { exactWords, relativeWords, useFamilyZone } from '../family-time.js';

/**
 * The household activity log (SHR-07).
 *
 * *Sarah downloaded "Home insurance policy" — yesterday, 4:12pm.* This is
 * what makes a shared vault trustworthy between adults: not restrictions,
 * but visibility. So it is a table of sentences and exactly when (5.1).
 *
 * From 768 px (R4) a plain table — when, who, what happened — whose only
 * controls are links: who to their page, a line about a document to the
 * document. Filters for who, what sort of thing and between which days,
 * kept in the address, sift the lines loaded; "Show older" loads more, as
 * before. Which lines anybody is given is the vault's to say, as ever: a
 * filter only leaves some of them out.
 *
 * One document's activity (0.9.0, DA): `?document=<id>`, from the Activity
 * button on its page, asks the vault for the lines about that document and
 * the links that gave it — the same lines the whole log shows the reader,
 * no others — said by a chip ("About ‘Richa’s visa’") whose × shows the
 * whole log again. A vault without `features.document_activity` shows the
 * whole log, as before.
 */
export function ActivityScreen() {
  const { withToken, authVersion, caps } = useApp();
  const wide = useShellMode() !== 'phone';
  const [params, setParams] = useSearchParams();
  const asked = params.get('document') ?? '';
  const about = caps?.features.document_activity === true ? asked : '';
  // Asked for one document: nothing is read until the vault has said
  // whether it can, so the whole log is never fetched only to be replaced.
  const undecided = asked !== '' && caps === null;
  // The first page comes from the usual loader; "show older" appends,
  // which is the only reason this screen keeps any state of its own. Each
  // answer says which document it is about, so a page loaded for another
  // (or for the whole log) is never shown as this one's.
  const {
    data: loaded,
    error: loadError,
    loading,
  } = useLoad(
    async (t) =>
      undecided
        ? null
        : {
            about,
            page: about ? await api.documentActivity(t, about) : await api.activity(t),
          },
    [authVersion, about, undecided],
  );
  const data = loaded?.about === about ? loaded.page : null;
  // Until this list's own first page has come (or could not).
  const waiting = loading || (data === null && !loadError);
  // The document the chip names: its title, or "a sensitive document".
  const { data: named } = useLoad(
    async (t) => (about ? { about, doc: await api.document(t, about).catch(() => null) } : null),
    [authVersion, about],
  );
  const doc = named?.about === about ? named.doc : null;
  const chip = about
    ? documentActivityWords(
        doc ? { title: doc.title, sensitive: doc.sensitive_effective === true } : null,
      )
    : '';
  const filtersRef = useRef<HTMLDivElement>(null);
  // Who each line's id names: the family, as the reader is given it.
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  // The household's time zone, which every role reads: its days are the
  // From and To filters' days. None said, this device's.
  const timezone = useFamilyZone();
  // What "Show older" brought, and for which document ('' the whole log):
  // another's is none of this list's.
  const [olderFor, setOlderFor] = useState<{ about: string; lines: ActivityLine[] }>({
    about: '',
    lines: [],
  });
  const older = olderFor.about === about ? olderFor.lines : [];
  // Undefined until "Show older" is used; then the next page, or null at
  // the end — which used to fall back to the first page's cursor, so the
  // button came back and the same page arrived twice.
  const [cursorFor, setCursorFor] = useState<{ about: string; next: number | null } | undefined>(
    undefined,
  );
  const cursor = cursorFor?.about === about ? cursorFor.next : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filters = filtersFrom(params);
  const setFilter = (key: keyof Filters, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const anyFilter = Object.values(filters).some(Boolean);
  /** Back to the whole log: the chip's ×. The focus stays among the filters. */
  const showEverything = () => {
    const next = new URLSearchParams(params);
    next.delete('document');
    // The whole log begins at its newest again.
    setOlderFor({ about: '', lines: [] });
    setCursorFor(undefined);
    setParams(next);
    filtersRef.current?.focus();
  };

  const lines = [...(data?.items ?? []), ...older];
  const next = cursor === undefined ? (data?.next ?? null) : cursor;
  const family = members ?? [];
  const shown = lines.filter((l) => matches(l, filters, family, timezone ?? null));

  const more = async (before: number) => {
    setBusy(true);
    const of = about;
    try {
      const page = await withToken((t) =>
        of ? api.documentActivity(t, of, before) : api.activity(t, before),
      );
      if (page) {
        setOlderFor((old) => ({
          about: of,
          lines: [...(old.about === of ? old.lines : []), ...page.items],
        }));
        setCursorFor({ about: of, next: page.next });
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const ids = useId();
  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title="What has been happening" />
      <ErrorNote message={error ?? loadError} />
      <p className="muted">
        Everything anybody has done in this vault. Your own private documents are only ever in your
        copy of this list.
      </p>
      <div
        ref={filtersRef}
        className="filters activity-filters"
        role="group"
        aria-label="Filters"
        tabIndex={-1}
      >
        {/* One document's lines (0.9.0, DA): said, and taken off. */}
        {about && (
          <span className="folder-chip">
            {chip}
            <button
              type="button"
              className="btn btn-quiet btn-small"
              aria-label={`Take off the filter ${chip}`}
              onClick={showEverything}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        )}
        <FilterSelect
          id={`${ids}-who`}
          label="Who"
          value={filters.who}
          options={[
            { value: '', label: 'Everybody' },
            ...family.map((m) => ({ value: m.id, label: m.display_name })),
            { value: ELSE, label: 'Anybody else' },
          ]}
          onChange={(v) => setFilter('who', v)}
        />
        <FilterSelect
          id={`${ids}-kind`}
          label="What happened"
          value={filters.kind}
          options={[{ value: '', label: 'Everything' }, ...ACTIVITY_KINDS]}
          onChange={(v) => setFilter('kind', v)}
        />
        <DayFilter
          id={`${ids}-from`}
          label="From"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(v) => setFilter('from', v)}
        />
        <DayFilter
          id={`${ids}-to`}
          label="To"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(v) => setFilter('to', v)}
        />
        {anyFilter && (
          <button
            type="button"
            className="btn btn-quiet btn-small"
            onClick={() =>
              // The document's chip stays: it has its own ×.
              setParams(about ? new URLSearchParams({ document: asked }) : new URLSearchParams())
            }
          >
            Clear filters
          </button>
        )}
        <p className="muted table-count" role="status">
          {waiting
            ? ''
            : anyFilter
              ? `${shown.length} of the ${lines.length} loaded match`
              : `${lines.length} loaded`}
        </p>
      </div>
      {wide ? (
        <div className="tbl-wrap tbl-static">
          <table className="tbl tbl-plain activity-tbl">
            <caption className="visually-hidden">
              {about
                ? `What has been happening, ${chipLower(chip)}, newest first`
                : 'What has been happening, newest first'}
            </caption>
            <colgroup>
              {/* Room for the family's zone after a time (0.9.0, TZ): "12:42pm GMT+5:30". */}
              <col style={{ width: 228 }} />
              <col style={{ width: 170 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What happened</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id} className={l.notable ? 'notable' : undefined}>
                  <td className="nowrap muted">
                    <When at={l.at} timezone={timezone ?? null} />
                  </td>
                  <td>
                    <Who line={l} family={family} />
                  </td>
                  <td>
                    <What line={l} />
                  </td>
                </tr>
              ))}
              {!waiting && shown.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={3}>{emptyWords(anyFilter, next !== null, about !== '')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What happened</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} className={l.notable ? 'notable' : undefined}>
                <td className="when">
                  <When at={l.at} timezone={timezone ?? null} />
                </td>
                <td>
                  <What line={l} />
                </td>
              </tr>
            ))}
            {!waiting && shown.length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  {emptyWords(anyFilter, next !== null, about !== '')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {next !== null && (
        <Button kind="quiet" disabled={busy} onClick={() => void more(next)}>
          {busy ? 'Loading…' : 'Show older'}
        </Button>
      )}
    </main>
  );
}

/** Who the filter asks for that is not one of the family the reader is given. */
const ELSE = 'else';

/** What the address asks the lines to be: each empty for any. */
interface Filters {
  /** A member's id, or `else`. */
  who: string;
  kind: string;
  /** Days, YYYY-MM-DD, on the household's calendar, as the times are said. */
  from: string;
  to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: readonly string[] = ACTIVITY_KINDS.map((k) => k.value);

function filtersFrom(params: URLSearchParams): Filters {
  const day = (k: string) => {
    const v = params.get(k) ?? '';
    return DAY.test(v) ? v : '';
  };
  const kind = params.get('kind') ?? '';
  return {
    who: params.get('who') ?? '',
    kind: KINDS.includes(kind) ? kind : '',
    from: day('from'),
    to: day('to'),
  };
}

/**
 * The day a moment falls on, on the household's calendar, as reminders and
 * a guest's end are counted; on this device's only while the vault has
 * said no time zone.
 */
function dayOf(iso: string, timezone: string | null): string {
  const at = new Date(iso);
  if (timezone) return localToday(timezone, at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Whether a line is one the filters keep. */
function matches(
  l: ActivityLine,
  f: Filters,
  family: readonly Member[],
  timezone: string | null,
): boolean {
  if (f.who) {
    const id = l.actor_member_id ?? null;
    const known = id !== null && family.some((m) => m.id === id);
    if (f.who === ELSE ? known : id !== f.who) return false;
  }
  if (f.kind && l.kind !== f.kind) return false;
  const day = f.from || f.to ? dayOf(l.at, timezone) : '';
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;
  return true;
}

function emptyWords(filtered: boolean, older: boolean, oneDocument: boolean): string {
  if (!filtered) return oneDocument ? documentActivityEmptyWords(older) : 'Nothing yet.';
  return older
    ? 'Nothing loaded matches these filters. Show older to look further back.'
    : 'Nothing matches these filters.';
}

/** "About ‘Passport’" as part of a sentence: "about ‘Passport’". */
function chipLower(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}

/** When, on the household's clock, as the From and To days are counted. */
function When({ at, timezone }: { at: string; timezone: string | null }) {
  return (
    <time dateTime={at} title={relativeWords(at, timezone ?? undefined)}>
      {exactWords(at, timezone ?? undefined)}
    </time>
  );
}

/**
 * Who did it: the person the line names, by their name in the family as
 * the reader is given it, and the way to their page. Anybody else — a
 * link, somebody the vault does not name, a guest — is said by the line
 * itself, never looked up.
 */
function Who({ line, family }: { line: ActivityLine; family: readonly Member[] }) {
  const m = line.actor_member_id ? family.find((x) => x.id === line.actor_member_id) : undefined;
  if (!m) {
    return (
      <>
        <span className="muted" aria-hidden="true">
          —
        </span>
        <span className="visually-hidden">Said in the line</span>
      </>
    );
  }
  return (
    <Link className="line-link" to={`/people/${m.id}`}>
      {m.display_name}
    </Link>
  );
}

/** What happened: the sentence, and the way to the document it is about where there is one. */
function What({ line }: { line: ActivityLine }) {
  return line.document_id ? (
    <Link className="line-link" to={`/documents/${line.document_id}`}>
      {line.text}
    </Link>
  ) : (
    <>{line.text}</>
  );
}

/** A day to filter from or to: its own label, seen. */
function DayFilter(props: {
  id: string;
  label: string;
  value: string;
  min?: string | undefined;
  max?: string | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <span className="filter filter-day">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="date"
        className={props.value ? 'on' : undefined}
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </span>
  );
}
