import { describe, expect, it } from 'vitest';
import { whenExactly, type ActivityLine } from './activity.js';
import {
  ACTIVITY_CSV_BOM,
  ACTIVITY_CSV_COLUMNS,
  ACTIVITY_CSV_MAX_LINES,
  activityCsvCapped,
  activityCsvCappedRow,
  activityCsvFileName,
  activityCsvHeader,
  activityCsvRow,
  activityCsvWhen,
  csvRecords,
  activityExportQuery,
  activityLineKept,
} from './activity-csv.js';

/** The activity log as a spreadsheet (0.9.0-dev.82). */
const line = (over: Partial<ActivityLine> = {}): ActivityLine => ({
  id: 1,
  at: '2026-11-21T16:12:00.000Z',
  text: 'Sara downloaded “Water bill”',
  notable: false,
  document_id: 'doc-1',
  actor_member_id: 'm-sara',
  kind: 'opened',
  ...over,
});

/** A row's cells, read back as RFC 4180 says. */
function cells(row: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i] as string;
    if (quoted) {
      if (c === '"' && row[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cell);
      cell = '';
    } else if (c === '\r' && row[i + 1] === '\n') break;
    else cell += c;
  }
  out.push(cell);
  return out;
}

describe('the activity log as CSV', () => {
  it('starts with a byte-order mark and the columns, each row ending CRLF', () => {
    const head = activityCsvHeader();
    expect(head.charCodeAt(0)).toBe(0xfeff);
    expect(ACTIVITY_CSV_BOM).toBe(String.fromCharCode(0xfeff));
    expect(cells(head.slice(1))).toEqual([...ACTIVITY_CSV_COLUMNS]);
    expect(head.endsWith('\r\n')).toBe(true);
    expect(activityCsvRow({ line: line(), who: 'Sara', document: 'Water bill' }, 'UTC')).toMatch(
      /[^\r]\r\n$/,
    );
  });

  it('a row says when on the family’s clock as the page does, in UTC too, who, what and the document', () => {
    const row = activityCsvRow(
      { line: line({ notable: true }), who: 'Sara', document: 'Water bill' },
      'Asia/Kolkata',
    );
    expect(cells(row)).toEqual([
      whenExactly('2026-11-21T16:12:00.000Z', 'Asia/Kolkata'),
      'Asia/Kolkata',
      '2026-11-21T16:12:00.000Z',
      'Sara',
      'Sara downloaded “Water bill”',
      'Opened and downloaded',
      'Water bill',
      'Yes',
    ]);
    expect(cells(row)[0]).toBe('21 Nov 2026, 9:42pm');
  });

  it('says each moment exactly as whenExactly does, in any zone', () => {
    for (const at of [
      '2026-01-01T00:00:00.000Z',
      '2026-06-30T23:59:00.000Z',
      '2026-11-21T12:05:00.000Z',
    ]) {
      for (const zone of ['UTC', 'Europe/London', 'America/Los_Angeles', 'Pacific/Auckland']) {
        expect(activityCsvWhen(at, zone)).toBe(whenExactly(at, zone));
      }
    }
    // A zone this runtime does not know is UTC, as the page's.
    expect(activityCsvWhen('2026-11-21T12:05:00.000Z', 'Nowhere/Atlantis')).toBe(
      whenExactly('2026-11-21T12:05:00.000Z', 'UTC'),
    );
  });

  it('quotes by RFC 4180: commas, quotes and line breaks kept as they are', () => {
    const row = activityCsvRow(
      {
        line: line({ text: 'Sam renamed “Bills, 2026” to "the “new” one"\nand more' }),
        who: 'O’Brien, Pat',
        document: null,
      },
      'UTC',
    );
    const c = cells(row);
    expect(c[3]).toBe('O’Brien, Pat');
    expect(c[4]).toBe('Sam renamed “Bills, 2026” to "the “new” one"\nand more');
    expect(row).toContain('"O’Brien, Pat"');
    expect(row).toContain('""the');
    expect(c[6]).toBe('');
  });

  it('never a formula: a cell from =, +, -, @, a tab or a carriage return on is text', () => {
    for (const evil of [
      '=HYPERLINK("https://example.test")',
      '+1',
      '-2+3',
      '@SUM(A1)',
      '\tx',
      '\rx',
    ]) {
      const row = activityCsvRow({ line: line({ text: evil }), who: evil, document: evil }, 'UTC');
      const c = cells(row);
      expect(c[3]).toBe(`'${evil}`);
      expect(c[4]).toBe(`'${evil}`);
      expect(c[6]).toBe(`'${evil}`);
    }
  });

  it('a file that stopped at its cap says so in its last row, and is told apart from one that did not', () => {
    const body =
      activityCsvHeader() +
      activityCsvRow({ line: line(), who: null, document: null }, 'UTC') +
      activityCsvCappedRow();
    expect(activityCsvCapped(body)).toBe(true);
    expect(activityCsvCappedRow()).toContain(
      new Intl.NumberFormat('en-GB').format(ACTIVITY_CSV_MAX_LINES),
    );
    expect(activityCsvCapped(activityCsvHeader())).toBe(false);
    // A line whose words begin the same way is not the cap's row.
    const said = activityCsvRow(
      { line: line({ text: '# Only the newest lines' }), who: null, document: null },
      'UTC',
    );
    expect(activityCsvCapped(activityCsvHeader() + said)).toBe(false);
    // Nor a cell whose last line, inside its quotes, begins with it: the
    // record is the line's, of every column.
    const fooled = activityCsvRow(
      {
        line: line({ text: 'Sam renamed it\r\n# Only the newest 5 lines are in this file.' }),
        who: null,
        document: 'Water bill\n# Only the newest',
      },
      'UTC',
    );
    expect(activityCsvCapped(activityCsvHeader() + fooled)).toBe(false);
    expect(activityCsvCapped(`${activityCsvHeader()}${fooled}`.trimEnd())).toBe(false);
    // As much of the log as one file reads: said by how far back it goes.
    const read = activityCsvCappedRow({ readTo: '3 Mar 2026, 4:12pm' });
    expect(read).toContain('it goes back to 3 Mar 2026, 4:12pm.');
    expect(activityCsvCapped(activityCsvHeader() + read)).toBe(true);
  });

  it('reads a CSV’s records as RFC 4180 says', () => {
    expect(csvRecords(ACTIVITY_CSV_BOM + 'a,"b,c","d""e"\r\n"f\r\ng",h\r\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['f\r\ng', 'h'],
    ]);
    expect(csvRecords('one\r\ntwo')).toEqual([['one'], ['two']]);
    expect(csvRecords('')).toEqual([]);
  });

  it('is named for the vault and the day, never a person', () => {
    expect(activityCsvFileName('2026-11-21')).toBe('activity-vault-2026-11-21.csv');
  });

  it('asks with the filters given, and nothing else', () => {
    expect(activityExportQuery({})).toBe('');
    expect(
      activityExportQuery({
        who: 'else',
        kind: 'opened',
        from: '2026-11-01',
        to: '',
        document: undefined,
      }),
    ).toBe('who=else&kind=opened&from=2026-11-01');
  });

  it('keeps a line by who, what sort and which day, as the page does', () => {
    const family = (id: string) => id === 'm-sara';
    const day = (iso: string) => iso.slice(0, 10);
    const none = { who: '', kind: '', from: '', to: '' };
    expect(activityLineKept(line(), none, family, day)).toBe(true);
    expect(activityLineKept(line(), { ...none, who: 'm-sara' }, family, day)).toBe(true);
    expect(activityLineKept(line(), { ...none, who: 'm-sam' }, family, day)).toBe(false);
    expect(activityLineKept(line(), { ...none, who: 'else' }, family, day)).toBe(false);
    expect(
      activityLineKept(line({ actor_member_id: null }), { ...none, who: 'else' }, family, day),
    ).toBe(true);
    expect(activityLineKept(line(), { ...none, kind: 'shared' }, family, day)).toBe(false);
    expect(
      activityLineKept(line(), { ...none, from: '2026-11-21', to: '2026-11-21' }, family, day),
    ).toBe(true);
    expect(activityLineKept(line(), { ...none, from: '2026-11-22' }, family, day)).toBe(false);
    expect(activityLineKept(line(), { ...none, to: '2026-11-20' }, family, day)).toBe(false);
  });
});
