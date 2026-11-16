import { describe, expect, it } from 'vitest';
import {
  attachmentDisposition,
  rfc5987,
  safeFileName,
  zipFileName,
  zipNames,
} from './zip-download.js';

/** A ZIP's names (0.9.0, DL; the DL review). */
describe('names in a ZIP', () => {
  it('keeps the letters of any script, in NFC, with their marks', () => {
    expect(safeFileName('بجلی کا بل')).toBe('بجلی کا بل');
    expect(safeFileName('فاتورة الكهرباء')).toBe('فاتورة الكهرباء');
    expect(safeFileName('شناختی کارڈ ۲۰۲۴')).toBe('شناختی کارڈ ۲۰۲۴');
    // An e and a combining acute become one é.
    expect(safeFileName('Re\u0301sume\u0301')).toBe('Résumé');
    expect(safeFileName('Pass_port 2031')).toBe('Pass_port 2031');
  });

  it('takes out control and direction characters, and makes a path a name', () => {
    // A right-to-left override would make "fdp.exe" read as "exe.pdf".
    expect(safeFileName('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    expect(safeFileName('a\u200fb\u0000c\nd')).toBe('abcd');
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('C:\\Windows\\x')).toBe('C_Windows_x');
    expect(safeFileName('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('is never empty, nor a device name, nor ending in a dot or a space', () => {
    expect(safeFileName('')).toBe('untitled');
    expect(safeFileName('...')).toBe('untitled');
    expect(safeFileName('\u202e')).toBe('untitled');
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('lpt1.txt')).toBe('_lpt1.txt');
    expect(safeFileName('Mr. ')).toBe('Mr');
  });

  it('cuts at 80 characters, never half of one', () => {
    // A letter outside the first plane: two UTF-16 units each.
    const long = '\u{20000}'.repeat(100);
    const cut = safeFileName(`a${long}`);
    expect(Array.from(cut)).toHaveLength(80);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('reserves the index’s own names, whatever their case', () => {
    const name = zipNames();
    expect(name('index', '.csv')).toBe('index (2).csv');
    expect(name('INDEX', '.html')).toBe('INDEX (2).html');
    expect(name('Passport', '.pdf')).toBe('Passport.pdf');
    expect(name('passport', '.pdf')).toBe('passport (2).pdf');
  });

  it('names the ZIP by its collection, in any script', () => {
    expect(zipFileName('سفر 2026', '2026-11-15')).toBe('سفر 2026 2026-11-15.zip');
    expect(zipFileName(null, '2026-11-15')).toBe('Family documents 2026-11-15.zip');
  });
});

describe('Content-Disposition (RFC 5987)', () => {
  it("escapes what encodeURIComponent leaves and the grammar does not allow: ' ( ) *", () => {
    expect(rfc5987("Ann's (copy)*.pdf")).toBe('Ann%27s%20%28copy%29%2A.pdf');
    expect(attachmentDisposition('بل.pdf')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('بل.pdf')}`,
    );
    expect(decodeURIComponent(rfc5987("O'Brien (1).zip"))).toBe("O'Brien (1).zip");
  });
});
