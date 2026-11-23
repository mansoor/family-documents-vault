import {
  ACTIVITY_ANYBODY_ELSE,
  ACTIVITY_CSV_MAX_LINES,
  ACTIVITY_KINDS,
  activityCsvFileName,
  activityLineKept,
  documentActivityEmptyWords,
  documentActivityWords,
  formatDate,
  localToday,
  type ActivityFilters,
  type ActivityLine,
} from '@fdv/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { useShellMode } from '../shell.js';
import { ChipRow, MultiFilter, type Chip } from '../multi-filter.js';
import { Button, ErrorNote, TopBar } from '../ui.js';
import { exactWords, relativeWords, useFamilyZone } from '../family-time.js';
import { NOTHING, PrintOut } from '../print.js';
import { saveFile } from '../save-file.js';

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
 * before. Who and what sort of thing each take several (0.9.0-dev.92):
 * any of them, said as chips below, each taken off by its ×, with Clear
 * all; the days and every filter together, all of them. Which lines
 * anybody is given is the vault's to say, as ever: a filter only leaves
 * some of them out.
 *
 * One document's activity (0.9.0, DA): `?document=<id>`, from "See all
 * activity" in the Activity panel on its page (0.9.0-dev.67), asks the vault for the lines about that document and
 * the links that gave it — the same lines the whole log shows the reader,
 * no others — said by a chip ("About ‘Richa’s visa’") whose × shows the
 * whole log again. A vault without `features.document_activity` shows the
 * whole log, as before.
 *
 * Print (0.9.0), on the bar on top: the lines the filters keep, as a table,
 * with who, what and which days were asked for said at the top. A From day
 * (or, without one, a To day) further back than the lines loaded so far has
 * the older lines loaded down to it first, as Show older would; the print
 * goes back as far as the lines loaded, and says how far when there are
 * older ones. Show older and Print wait for each other.
 *
 * Download CSV (0.9.0-dev.82, `features.activity_export`), beside Print:
 * the vault writes the lines the same filters keep — who, what, which days,
 * the document of the chip — as a spreadsheet, every one it has, not only
 * those loaded, as it shows them to the reader. Past its cap it holds the
 * newest, and the page says so.
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
  // Print (0.9.0): the older lines it needs on their way, then the printing.
  const [preparing, setPreparing] = useState(false);
  const [printing, setPrinting] = useState(false);
  // Download CSV (0.9.0-dev.82): on its way, and whether the file stopped at its cap.
  const exportable = caps?.features.activity_export === true;
  const [downloading, setDownloading] = useState(false);
  // Pressed twice before the first has answered: once.
  const downloadingNow = useRef(false);
  // The filters (and document) whose file stopped at its cap: the note goes
  // as soon as they change.
  const [cappedFor, setCappedFor] = useState<string | null>(null);
  // Still shown, and about which document: a print being prepared stops
  // when the page goes, and is not printed under another document's chip.
  const alive = useRef(true);
  const aboutNow = useRef(about);
  useEffect(() => {
    aboutNow.current = about;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const filters = filtersFrom(params);
  const askedNow = JSON.stringify([filters, about]);
  const capped = cappedFor === askedNow;
  const setFilter = (key: 'from' | 'to', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  /** Who or what sort of thing: each choice given once in the address. */
  const setChoices = (key: 'who' | 'kind', values: readonly string[]) => {
    const next = new URLSearchParams(params);
    next.delete(key);
    for (const v of values) next.append(key, v);
    setParams(next);
  };
  const anyFilter =
    filters.who.length > 0 || filters.kind.length > 0 || filters.from !== '' || filters.to !== '';
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
  const whoChoices = [
    ...family.map((m) => ({ value: m.id, label: m.display_name })),
    { value: ELSE, label: 'Anybody else' },
  ];
  // The choices made, a chip each (0.9.0-dev.92); the days, a chip each too.
  const day = (d: string) => formatDate({ date: d, precision: 'day' });
  const chips: Chip[] = [
    ...filters.who.map((w) => ({
      key: `who:${w}`,
      words: `Who: ${whoWords(w, family)}`,
      clear: () =>
        setChoices(
          'who',
          filters.who.filter((x) => x !== w),
        ),
    })),
    ...filters.kind.map((k) => ({
      key: `kind:${k}`,
      words: `What happened: ${kindWords(k)}`,
      clear: () =>
        setChoices(
          'kind',
          filters.kind.filter((x) => x !== k),
        ),
    })),
    ...(filters.from
      ? [{ key: 'from', words: `From ${day(filters.from)}`, clear: () => setFilter('from', '') }]
      : []),
    ...(filters.to
      ? [{ key: 'to', words: `To ${day(filters.to)}`, clear: () => setFilter('to', '') }]
      : []),
  ];
  const shown = lines.filter((l) => matches(l, filters, family, timezone ?? null));

  /** Older lines, after those there: each line once, whatever asked for it. */
  const addOlder = (of: string, items: readonly ActivityLine[], nextCursor: number | null) => {
    setOlderFor((old) => {
      const kept = old.about === of ? old.lines : [];
      const have = new Set([...(data?.items ?? []), ...kept].map((l) => l.id));
      return { about: of, lines: [...kept, ...items.filter((l) => !have.has(l.id))] };
    });
    setCursorFor({ about: of, next: nextCursor });
  };

  const more = async (before: number) => {
    if (busy || preparing || printing) return;
    setBusy(true);
    const of = about;
    try {
      const page = await withToken((t) =>
        of ? api.documentActivity(t, of, before) : api.activity(t, before),
      );
      if (page && alive.current) addOlder(of, page.items, page.next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // Print waits for the first page, and for Show older; with no first page
  // there is nothing to print.
  const mayPrint = !waiting && data !== null && !busy && !preparing && !printing;
  /**
   * Print: with a From day (or else a To day), the older lines down to it
   * first (fifty pages at most), kept on the screen as Show older keeps
   * them; then the lines the filters keep. Not printed if the page has
   * gone, or now shows another document's lines.
   */
  const print = async () => {
    if (!mayPrint) return;
    setPreparing(true);
    setError(null);
    const of = about;
    const bound = filters.from || filters.to;
    try {
      const extra: ActivityLine[] = [];
      let cursorNow = next;
      let oldest = lines.at(-1)?.at ?? null;
      for (
        let round = 0;
        bound &&
        cursorNow !== null &&
        oldest !== null &&
        dayOf(oldest, timezone ?? null) >= bound &&
        round < 50;
        round++
      ) {
        const before = cursorNow;
        const page = await withToken((t) =>
          of ? api.documentActivity(t, of, before) : api.activity(t, before),
        );
        if (!page || !alive.current || aboutNow.current !== of) return;
        extra.push(...page.items);
        cursorNow = page.next;
        oldest = page.items.at(-1)?.at ?? null;
      }
      if (!alive.current || aboutNow.current !== of) return;
      if (extra.length > 0) addOlder(of, extra, cursorNow);
      setPrinting(true);
    } catch (err) {
      if (alive.current) setError(describeError(err));
    } finally {
      if (alive.current) setPreparing(false);
    }
  };

  /**
   * Download CSV: the vault's file of the lines these filters keep, for the
   * document of the chip when there is one; saved as the vault names it.
   */
  const downloadCsv = async () => {
    if (downloadingNow.current || undecided) return;
    setError(null);
    setCappedFor(null);
    // Days the other way round: said here, as the vault would refuse them.
    if (filters.from && filters.to && filters.from > filters.to) {
      setError('From is after To: choose days in order.');
      return;
    }
    downloadingNow.current = true;
    setDownloading(true);
    const of = askedNow;
    try {
      const file = await withToken((t) =>
        api.activityCsv(t, { ...filters, ...(about ? { document: about } : {}) }),
      );
      if (!file || !alive.current) return;
      saveFile(file.blob, file.filename ?? activityCsvFileName(localToday(timezone ?? 'UTC')));
      if (file.capped) setCappedFor(of);
    } catch (err) {
      if (alive.current) setError(describeError(err));
    } finally {
      downloadingNow.current = false;
      if (alive.current) setDownloading(false);
    }
  };

  const ids = useId();
  return (
    <main className="page page-top page-wide has-nav">
      <TopBar
        title="What has been happening"
        action={
          <>
            {exportable && (
              <button
                type="button"
                className="btn btn-quiet"
                style={{ minHeight: 40 }}
                aria-disabled={downloading || undecided ? true : undefined}
                onClick={() => void downloadCsv()}
              >
                {downloading ? 'Downloading…' : 'Download CSV'}
              </button>
            )}
            {/* Never disabled outright: pressed, it keeps the focus while it
                prepares, and says it is not to be pressed meanwhile. */}
            <button
              type="button"
              className="btn btn-quiet"
              style={{ minHeight: 40 }}
              aria-disabled={mayPrint ? undefined : true}
              onClick={() => void print()}
            >
              {preparing ? 'Preparing…' : 'Print'}
            </button>
          </>
        }
      />
      {printing && (
        <PrintOut
          title="What has been happening"
          about={
            <ActivityPrintAbout
              chip={about ? chip : ''}
              filters={filters}
              family={family}
              count={shown.length}
              older={next !== null ? (lines.at(-1)?.at ?? null) : null}
              reachedFrom={
                filters.from !== '' &&
                lines.length > 0 &&
                dayOf(lines.at(-1)?.at as string, timezone ?? null) < filters.from
              }
              timezone={timezone ?? null}
            />
          }
          onDone={() => setPrinting(false)}
        >
          <table className="print-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What happened</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{exactWords(l.at, timezone ?? undefined)}</td>
                  <td>{family.find((m) => m.id === l.actor_member_id)?.display_name ?? NOTHING}</td>
                  <td>{l.text}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={3}>{emptyWords(anyFilter, false, about !== '')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </PrintOut>
      )}
      <ErrorNote message={error ?? loadError} />
      {capped && (
        <p className="notice" role="status">
          Only the newest lines are in the file: it holds{' '}
          {new Intl.NumberFormat('en-GB').format(ACTIVITY_CSV_MAX_LINES)} at most, and reads only so
          much of the log. Choose fewer days or a narrower filter for the rest.
        </p>
      )}
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
        <MultiFilter
          id={`${ids}-who`}
          label="Who"
          any="Everybody"
          values={filters.who}
          options={whoChoices}
          unknown={(v) => whoWords(v, family)}
          find="Find a person"
          onChange={(v) => setChoices('who', v)}
        />
        <MultiFilter
          id={`${ids}-kind`}
          label="What happened"
          any="Everything"
          values={filters.kind}
          options={ACTIVITY_KINDS}
          onChange={(v) => setChoices('kind', v)}
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
        <p className="muted table-count" role="status">
          {waiting
            ? ''
            : anyFilter
              ? `${shown.length} of the ${lines.length} loaded match`
              : `${lines.length} loaded`}
        </p>
      </div>
      {/* Always there, so the focus has somewhere to go when the last chip does. */}
      <ChipRow
        label="Filters chosen"
        chips={chips}
        onClearAll={() =>
          // The document's chip stays: it has its own ×.
          setParams(about ? new URLSearchParams({ document: asked }) : new URLSearchParams())
        }
        fallback={filtersRef}
      />
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
        <Button
          kind="quiet"
          disabled={busy || preparing || printing}
          onClick={() => void more(next)}
        >
          {busy ? 'Loading…' : 'Show older'}
        </Button>
      )}
    </main>
  );
}

/** Who the filter asks for that is not one of the family the reader is given. */
const ELSE = ACTIVITY_ANYBODY_ELSE;

/**
 * What a printed log is (0.9.0): the document it is about, if one; who,
 * what and which days the filters ask for, each said even when it is
 * everything; how many lines; and, where older lines were not loaded, how
 * far back it goes.
 */
export function ActivityPrintAbout(props: {
  chip: string;
  filters: Filters;
  family: readonly Member[];
  count: number;
  /** The oldest line printed's moment, when there are older ones not loaded. */
  older: string | null;
  /** The lines loaded reach back past the From day: nothing in range is left out. */
  reachedFrom: boolean;
  timezone: string | null;
}) {
  const { filters: f } = props;
  // Several of one filter, any of them (0.9.0-dev.92): "Sara or Sam".
  const who =
    f.who.length === 0 ? 'Everybody' : f.who.map((w) => whoWords(w, props.family)).join(' or ');
  const what = f.kind.length === 0 ? 'Everything' : f.kind.map(kindWords).join(' or ');
  const day = (d: string) => formatDate({ date: d, precision: 'day' });
  const days =
    f.from && f.to
      ? `${day(f.from)} to ${day(f.to)}`
      : f.from
        ? `From ${day(f.from)}`
        : f.to
          ? `Up to ${day(f.to)}`
          : 'Any day';
  return (
    <>
      {props.chip && <p className="print-about">{props.chip}</p>}
      <p className="print-about">
        Who: {who} · What happened: {what} · When: {days}
      </p>
      <p className="print-about">
        {props.count === 1 ? '1 line' : `${props.count} lines`}, newest first.
        {props.older && !props.reachedFrom
          ? ` Older lines weren’t loaded: this goes back to ${exactWords(props.older, props.timezone ?? undefined)}.`
          : ''}
      </p>
    </>
  );
}

/** What the address asks the lines to be: each empty for any. */
type Filters = ActivityFilters;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: readonly string[] = ACTIVITY_KINDS.map((k) => k.value);

/** Who a Who filter's value names: one of the family, anybody else, or somebody not given. */
function whoWords(value: string, family: readonly Member[]): string {
  if (value === ELSE) return 'Anybody else';
  return family.find((m) => m.id === value)?.display_name ?? 'Somebody';
}

/** A sort of thing, in words. */
function kindWords(value: string): string {
  return ACTIVITY_KINDS.find((k) => k.value === value)?.label ?? value;
}

/**
 * The filters as the address has them: who and what sort of thing each
 * given once a choice (0.9.0-dev.92) — or, from an older link, one, or
 * several comma-separated — and a sort of thing there is not left out.
 */
function filtersFrom(params: URLSearchParams): Filters {
  const day = (k: string) => {
    const v = params.get(k) ?? '';
    return DAY.test(v) ? v : '';
  };
  const several = (k: string) => [
    ...new Set(
      params
        .getAll(k)
        .flatMap((v) => v.split(','))
        .map((v) => v.trim())
        .filter((v) => v !== ''),
    ),
  ];
  return {
    who: several('who'),
    kind: several('kind').filter((k) => KINDS.includes(k)),
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

/** Whether a line is one the filters keep: as the vault's export asks it. */
function matches(
  l: ActivityLine,
  f: Filters,
  family: readonly Member[],
  timezone: string | null,
): boolean {
  return activityLineKept(
    l,
    f,
    (id) => family.some((m) => m.id === id),
    (iso) => dayOf(iso, timezone),
  );
}

function emptyWords(filtered: boolean, older: boolean, oneDocument: boolean): string {
  if (!filtered) return oneDocument ? documentActivityEmptyWords(older) : 'Nothing yet.';
  return older
    ? 'Nothing loaded matches these filters. Show older to look further back.'
    : 'Nothing matches these filters.';
}

/** "About ‘Passport’" as part of a sentence: "about ‘Passport’". */
export function chipLower(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}

/** When, on the household's clock, as the From and To days are counted. */
export function When({ at, timezone }: { at: string; timezone: string | null }) {
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
export function What({ line }: { line: ActivityLine }) {
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
