/**
 * The activity log as a spreadsheet (0.9.0-dev.82; the owner's ask of 19 Nov
 * 2026): `GET /api/v1/audit/export`, with the filters the Activity page has,
 * answers the lines they keep as CSV — the same lines, in the same words, as
 * the page shows its reader, and nothing it does not.
 *
 * What a file holds, and how, is said once here, for the vault, the fake
 * vault and the web: the filters a line is kept by, the columns, a cell as a
 * spreadsheet must take it, the file's name, and the row that says a file
 * stopped at its cap.
 */

import { ACTIVITY_KINDS, type ActivityLine } from './activity.js';
import { csvCell } from './zip-download.js';

/** The most lines one file holds: past it, the newest this many, and a row that says so. */
export const ACTIVITY_CSV_MAX_LINES = 50_000;

/** Who the Who filter asks for that is not one of the family the reader is given. */
export const ACTIVITY_ANYBODY_ELSE = 'else';

/**
 * The Activity page's filters, each empty for any: as its address has them.
 * Who and what may each hold several (0.9.0-dev.92): any of them.
 */
export interface ActivityFilters {
  /** Members' ids, or `else` (`ACTIVITY_ANYBODY_ELSE`): any of them. */
  who: readonly string[];
  /** `ActivityKind`s: any of them. */
  kind: readonly string[];
  /** Days, YYYY-MM-DD, on the household's calendar, as its times are said. */
  from: string;
  to: string;
}

/**
 * Whether a line is one the filters keep, as the Activity page sifts the
 * lines it has loaded and the export the lines it writes: who did it (any
 * of the family asked, by id, or anybody else), what sort of thing it was
 * (any of those asked), and the day it was on (`dayOf`, on the household's
 * calendar; asked only when a day is).
 */
export function activityLineKept(
  l: Pick<ActivityLine, 'at' | 'actor_member_id' | 'kind'>,
  f: ActivityFilters,
  isFamily: (memberId: string) => boolean,
  dayOf: (iso: string) => string,
): boolean {
  if (f.who.length > 0) {
    const id = l.actor_member_id ?? null;
    const known = id !== null && isFamily(id);
    if (!f.who.some((w) => (w === ACTIVITY_ANYBODY_ELSE ? !known : id === w))) return false;
  }
  if (f.kind.length > 0 && (l.kind === undefined || !f.kind.includes(l.kind))) return false;
  const day = f.from || f.to ? dayOf(l.at) : '';
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;
  return true;
}

/** A file's columns, in order. */
export const ACTIVITY_CSV_COLUMNS = [
  'When',
  'Time zone',
  'When (UTC)',
  'Who',
  'What happened',
  'Kind',
  'Document',
  'Notable',
] as const;

/** One line as a row: the line, and what the page shows beside its words. */
export interface ActivityCsvLine {
  line: ActivityLine;
  /** Who did it, by their name in the family as the reader is given it; null when the line says. */
  who: string | null;
  /**
   * The document it is about as its line names it: its title, or "a
   * sensitive document" for a Sensitive one (H1a); null for a line about
   * none, or one with no title left.
   */
  document: string | null;
}

/** RFC 4180's line break. */
const CRLF = '\r\n';

/** The byte-order mark, so a spreadsheet reads the file as UTF-8. */
export const ACTIVITY_CSV_BOM = String.fromCharCode(0xfeff);

/** The file's start: the byte-order mark and the columns' names. */
export function activityCsvHeader(): string {
  return `${ACTIVITY_CSV_BOM}${ACTIVITY_CSV_COLUMNS.map(csvCell).join(',')}${CRLF}`;
}

/**
 * A moment as the Activity page says it, "21 Nov 2026, 4:12pm", on the
 * household's clock: `whenExactly`'s words, with its formatters made once a
 * zone — fifty thousand rows would otherwise make a hundred thousand.
 */
const formatters = new Map<string, { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }>();
export function activityCsvWhen(iso: string, zone: string): string {
  let f = formatters.get(zone);
  if (!f) {
    let timeZone = zone;
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone });
    } catch {
      timeZone = 'UTC';
    }
    f = {
      date: new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone,
      }),
      time: new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone,
      }),
    };
    formatters.set(zone, f);
  }
  const at = new Date(iso);
  return `${f.date.format(at)}, ${f.time.format(at).replace(/\s/g, '').toLowerCase()}`;
}

/**
 * One line as a row of the file, every cell as `csvCell` writes it: quoted
 * where RFC 4180 asks, and never a formula.
 */
export function activityCsvRow(r: ActivityCsvLine, zone: string): string {
  const kind = ACTIVITY_KINDS.find((k) => k.value === r.line.kind)?.label ?? '';
  return (
    [
      activityCsvWhen(r.line.at, zone),
      zone,
      new Date(r.line.at).toISOString(),
      r.who ?? '',
      r.line.text,
      kind,
      r.document ?? '',
      r.line.notable ? 'Yes' : '',
    ]
      .map((v) => csvCell(v))
      .join(',') + CRLF
  );
}

/** How the row that says a file stopped at its cap begins. */
export const ACTIVITY_CSV_CAPPED_MARK = '# Only the newest';

/**
 * Why a file stopped short: it held its most lines, or the vault read as
 * much of the log as one file reads (`readTo`, said as the page says a
 * moment: the newest it holds no lines before).
 */
export type ActivityCsvCap = { lines: number } | { readTo: string };

/**
 * The file's last row when it stopped short: in its first cell, alone, so a
 * spreadsheet shows it under the last line.
 */
export function activityCsvCappedRow(
  cap: ActivityCsvCap = { lines: ACTIVITY_CSV_MAX_LINES },
): string {
  const why =
    'lines' in cap
      ? `${ACTIVITY_CSV_CAPPED_MARK} ${new Intl.NumberFormat('en-GB').format(cap.lines)} lines are in this file.`
      : `${ACTIVITY_CSV_CAPPED_MARK} lines are in this file: it goes back to ${cap.readTo}.`;
  return `${csvCell(`${why} Choose fewer days or a narrower filter for the rest.`)}${CRLF}`;
}

/**
 * A CSV's records, as RFC 4180 reads them: fields in quotes may hold
 * commas, doubled quotes and line breaks. A byte-order mark is not a field's.
 */
export function csvRecords(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    any = true;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || (c === '\r' && body[i + 1] === '\n')) {
      if (c === '\r') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      any = false;
    } else field += c;
  }
  if (any) records.push([...record, field]);
  return records;
}

/**
 * Whether a file stopped at its cap: its last record is the cap's row — one
 * field, beginning with the mark — never a line's words that happen to.
 */
export function activityCsvCapped(text: string): boolean {
  const last = csvRecords(text).at(-1);
  return last?.length === 1 && (last[0] ?? '').startsWith(ACTIVITY_CSV_CAPPED_MARK);
}

/**
 * The file's name, as the browser saves it: `activity-vault-2026-11-21.csv`,
 * on the household's calendar. Never a person's or the family's name.
 */
export function activityCsvFileName(today: string): string {
  return `activity-vault-${today}.csv`;
}

/**
 * What `GET /api/v1/audit/export` is asked: the page's filters, and one
 * document's lines. Several who and kinds (0.9.0-dev.92,
 * `features.multi_filters`): each given once, any of them.
 */
export interface ActivityExportAsk {
  who?: string | readonly string[] | undefined;
  kind?: string | readonly string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** One document's lines (as `?document=` on the page, 0.9.0, DA). */
  document?: string | undefined;
}

/**
 * The export's query, with only the filters asked: `who=…&kind=opened&from=2026-11-01`;
 * several of one, the field once for each (`kind=opened&kind=shared`).
 */
export function activityExportQuery(ask: ActivityExportAsk): string {
  return (['who', 'kind', 'from', 'to', 'document'] as const)
    .flatMap((k) => {
      const v = ask[k];
      const all: readonly string[] = v === undefined ? [] : typeof v === 'string' ? [v] : v;
      return all.filter((x) => x !== '').map((x) => `${k}=${encodeURIComponent(x)}`);
    })
    .join('&');
}
