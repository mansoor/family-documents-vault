import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * An Only me document's notes and details (0.5.8), sealed under its owner's
 * member key as its pages' text is (0007): kept in no plain column, in no
 * search index, and in no backup as words. They are opened only in their
 * owner's own request — their look at the document, their private search
 * pass, their export — and never kept opened.
 *
 * Each is AES-256-GCM under a fresh nonce, bound to its document and to
 * what it is, so a blob copied to another document, or from the notes into
 * the details, does not open:
 *
 *   iv (12) || ciphertext || tag (16),  additional data "notes:<id>" or "extra:<id>"
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface PrivateValues {
  notes: string | null;
  extra: Record<string, unknown>;
}

export interface SealedValues {
  notes_sealed: Buffer | null;
  extra_sealed: Buffer | null;
  /**
   * The details that have a value, by key. Written with them, while they
   * are open, so that what a document still needs can be worked out
   * without opening them: in a list, a search, the nightly refresh.
   */
  sealed_details: string[];
}

/** No value: nothing, blank text, an empty list — as a required field sees it. */
const blank = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

function seal(key: Buffer, plain: string, binding: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(binding, 'utf8'));
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, binding: string): string {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('sealed value is too short');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  d.setAAD(Buffer.from(binding, 'utf8'));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      d.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
      d.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('sealed value failed authentication: wrong key, or it was altered or moved');
  }
}

/** Seals a document's notes and details. Nothing to seal is null, not an empty blob. */
export function sealPrivate(key: Buffer, documentId: string, values: PrivateValues): SealedValues {
  const details = Object.keys(values.extra).filter((k) => !blank(values.extra[k]));
  return {
    notes_sealed: blank(values.notes)
      ? null
      : seal(key, values.notes as string, `notes:${documentId}`),
    extra_sealed: details.length
      ? seal(key, JSON.stringify(values.extra), `extra:${documentId}`)
      : null,
    sealed_details: details,
  };
}

/**
 * Opens what `sealPrivate` sealed. A blob that does not open is an error,
 * not "no notes": whoever asked would otherwise write over what they could
 * not see.
 */
export function openPrivate(
  key: Buffer,
  documentId: string,
  sealed: Pick<SealedValues, 'notes_sealed' | 'extra_sealed'>,
): PrivateValues {
  const extra = sealed.extra_sealed
    ? (JSON.parse(open(key, sealed.extra_sealed, `extra:${documentId}`)) as unknown)
    : {};
  return {
    notes: sealed.notes_sealed ? open(key, sealed.notes_sealed, `notes:${documentId}`) : null,
    extra:
      extra && typeof extra === 'object' && !Array.isArray(extra)
        ? (extra as Record<string, unknown>)
        : {},
  };
}
