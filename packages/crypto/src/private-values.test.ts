import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openPrivate, sealPrivate } from './private-values.js';
import { newKey } from './wrap.js';

describe("an Only me document's notes and details", () => {
  const key = newKey();
  const id = randomUUID();

  it('open again as they were, and say which details have a value', () => {
    const extra = { vin: 'JM1BK32F781234567', plate: 'KX19 ZLT', insured: false, seats: 5 };
    const sealed = sealPrivate(key, id, { notes: 'Spare key is with Sana.', extra });
    expect(sealed.sealed_details.sort()).toEqual(['insured', 'plate', 'seats', 'vin']);
    const blob = Buffer.concat([sealed.notes_sealed as Buffer, sealed.extra_sealed as Buffer]);
    for (const word of ['Spare', 'Sana', 'JM1BK32F781234567', 'KX19']) {
      expect(blob.toString('latin1')).not.toContain(word);
    }
    expect(openPrivate(key, id, sealed)).toEqual({ notes: 'Spare key is with Sana.', extra });
  });

  it('nothing to seal is nothing, not an empty blob', () => {
    const sealed = sealPrivate(key, id, { notes: '  ', extra: { vin: '', tags: [] } });
    expect(sealed).toEqual({ notes_sealed: null, extra_sealed: null, sealed_details: [] });
    expect(openPrivate(key, id, sealed)).toEqual({ notes: null, extra: {} });
  });

  it('do not open under another key, on another document, or swapped over', () => {
    const sealed = sealPrivate(key, id, { notes: 'A note', extra: { vin: 'X1' } });
    expect(() => openPrivate(newKey(), id, sealed)).toThrow(/failed authentication/);
    expect(() => openPrivate(key, randomUUID(), sealed)).toThrow(/failed authentication/);
    expect(() =>
      openPrivate(key, id, { notes_sealed: sealed.extra_sealed, extra_sealed: null }),
    ).toThrow(/failed authentication/);
    const altered = Buffer.from(sealed.notes_sealed as Buffer);
    altered[14] = (altered[14] as number) ^ 1;
    expect(() => openPrivate(key, id, { notes_sealed: altered, extra_sealed: null })).toThrow(
      /failed authentication/,
    );
  });
});
