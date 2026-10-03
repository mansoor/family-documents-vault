import { describe, expect, it } from 'vitest';
import { dropFileName } from './upload-requests.js';

/**
 * A sent file's name as the vault keeps it (5.21), and as the sender's page
 * compares it when it looks for a file it sent (the 5.22 review, N522W2-2).
 */
describe('dropFileName', () => {
  it('keeps the name as the vault does: NFC, one space, trimmed, its last part', () => {
    expect(dropFileName('Re\u0301sume\u0301  2025.pdf')).toBe('Résumé 2025.pdf');
    expect(dropFileName('  W-2\t 2025 .pdf ')).toBe('W-2 2025 .pdf');
    expect(dropFileName('C:\\Users\\jane\\Scans\\w2.pdf')).toBe('w2.pdf');
    expect(dropFileName('../../etc/passwd')).toBe('passwd');
    // No control or direction characters.
    expect(dropFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(dropFileName('a\u0000b\u0007c.pdf')).toBe('abc.pdf');
  });

  it('is never empty, never a path step, and at most 200 characters', () => {
    expect(dropFileName('')).toBe('file');
    expect(dropFileName('..')).toBe('file');
    expect(dropFileName('a/')).toBe('file');
    expect([...dropFileName(`${'é'.repeat(250)}.pdf`)]).toHaveLength(200);
  });
});
