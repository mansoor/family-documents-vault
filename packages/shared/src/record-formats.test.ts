import { describe, expect, it } from 'vitest';
import {
  claimedRecordFormat,
  deliveredType,
  isRecordFormat,
  recordByBytes,
  recordFileName,
  recordNoPreviewWords,
  STORED_KINDS,
  viewNotPossibleWords,
} from './record-formats.js';
import { sensitiveBackupsWords } from './sensitive.js';
import { canShareToView, sensitiveLinkStart, sensitiveLinkStartWords } from './shares.js';
import { incomingFileName } from './upload-requests.js';
import { UPLOAD_KINDS } from './wire.js';

/** Health records kept as they are, sensitive links and backups (0.9.0, H5). */
describe('health records kept as they are', () => {
  it('are claimed by their type, or by their name when the type says nothing', () => {
    expect(claimedRecordFormat('text/xml; charset=utf-8', 'x')).toBe('application/xml');
    expect(claimedRecordFormat('application/fhir+json', 'x')).toBe('application/json');
    expect(claimedRecordFormat('application/x-zip-compressed', 'x')).toBe('application/zip');
    expect(claimedRecordFormat('', 'IM0001.DCM')).toBe('application/dicom');
    expect(claimedRecordFormat('application/octet-stream', 'export.json')).toBe('application/json');
    // A PDF, a photo or an Office file is never a record, whatever it is called.
    expect(claimedRecordFormat('application/pdf', 'a.xml')).toBeNull();
    expect(claimedRecordFormat('image/jpeg', 'a.zip')).toBeNull();
    expect(claimedRecordFormat('', 'notes.txt')).toBeNull();
    // Plain text names (the review): .json and .xml taken, .ndjson not.
    expect(claimedRecordFormat('text/plain', 'export.json')).toBe('application/json');
    expect(claimedRecordFormat('text/plain', 'export.ndjson')).toBeNull();
    // Known by its bytes alone only when its type says nothing.
    expect(recordByBytes('', 'application/dicom')).toBe('application/dicom');
    expect(recordByBytes('application/octet-stream', 'application/zip')).toBe('application/zip');
    expect(recordByBytes('image/jpeg', 'application/dicom')).toBeNull();
    expect(recordByBytes('', 'application/pdf')).toBeNull();
    // Kept and downloaded ending as what it is.
    expect(recordFileName('invoice.html', 'application/xml')).toBe('invoice.xml');
    expect(recordFileName('IM00001', 'application/dicom')).toBe('IM00001.dcm');
    expect(recordFileName('export.json', 'application/json')).toBe('export.json');
    expect(recordFileName('scan.pdf', 'application/pdf')).toBe('scan.pdf');
  });

  it('are kept, never drawn, and sent as a type no browser renders', () => {
    for (const mime of [
      'application/xml',
      'application/json',
      'application/dicom',
      'application/zip',
    ]) {
      expect(isRecordFormat(mime)).toBe(true);
      expect(STORED_KINDS[mime]).toBeDefined();
      expect(UPLOAD_KINDS[mime]).toBeUndefined();
      expect(canShareToView(mime)).toBe(false);
    }
    expect(deliveredType('application/xml')).toBe('application/octet-stream');
    expect(deliveredType('application/json')).toBe('application/octet-stream');
    expect(deliveredType('application/zip')).toBe('application/zip');
    expect(deliveredType('application/pdf')).toBe('application/pdf');
    expect(isRecordFormat('application/pdf')).toBe(false);
    expect(incomingFileName('portal export.zip', 'application/zip')).toBe('portal export.zip');
    expect(incomingFileName('IM0001', 'application/dicom')).toBe('IM0001.dcm');
  });

  it('say why there is no preview, and why a link to view can’t give them', () => {
    expect(recordNoPreviewWords('application/xml')).toBe(
      'No preview. This is an XML file (such as C-CDA), kept as it is: the vault doesn’t open, read or draw it. Download it to open it in the program it’s for. Your patient portal’s PDF is the readable copy.',
    );
    expect(viewNotPossibleWords('application/dicom')).toMatch(
      /^Health record files kept as they are/,
    );
    expect(
      viewNotPossibleWords('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toMatch(/^Word and Excel files/);
  });
});

describe('a sensitive document’s link', () => {
  it('starts view-only for a week, or to download where it can’t be shown', () => {
    expect(sensitiveLinkStart({ sensitive: true, viewable: true })).toEqual({
      permission: 'view',
      days: 7,
    });
    expect(sensitiveLinkStart({ sensitive: true, viewable: false })).toEqual({
      permission: 'download',
      days: 7,
    });
    expect(sensitiveLinkStart({ sensitive: false, viewable: true })).toBeNull();
    expect(sensitiveLinkStartWords({ viewable: true })).toBe(
      'This is sensitive, so the link starts as view-only and ends in a week. You can change either.',
    );
    expect(sensitiveLinkStartWords({ viewable: false, collection: true })).toMatch(
      /^Some of these are sensitive, so the link ends in a week\./,
    );
  });
});

describe('a sensitive document deleted', () => {
  it('names how long backups hold it, or says until they age out', () => {
    expect(sensitiveBackupsWords(30, { forGood: true })).toBe(
      'It’s sensitive. Older backups still hold it — its details in the vault’s backups, and its file in any copy of the vault’s files kept elsewhere — until they age out: the vault keeps its nightly backups for 30 days.',
    );
    expect(sensitiveBackupsWords(null, { forGood: false })).toBe(
      'It’s sensitive. Even once it’s deleted for good, older backups still hold it — its details in the vault’s backups, and its file in any copy of the vault’s files kept elsewhere — until your backups age out.',
    );
    expect(sensitiveBackupsWords(1, { forGood: true, n: 2 })).toMatch(
      /^2 of them are sensitive\. Older backups still hold them — their details .* for 1 day\.$/,
    );
  });
});
