import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * An Only me document's notes and details (0.5.8), sealed under its owner's
 * member key as its pages' text is (0007): kept in no plain column, in no
 * search index, and in no backup as words. They are opened only in their
 * owner's own request — their look at the document, their private search
 * pass, their export — and never kept opened.
 *
 * With one exception (0.5.15, A62): the date its kind reminds from, when
 * that is one of its details — a bill's due date. The vault's
 * types.regenerate job opens the details for that one date, in the
 * document's own transaction, never in the Trash, and passes on nothing
 * else; it is never logged or kept. Its only plain trace is the reminder
 * rows (their day and lead time), as an Only me expiry date's already is.
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
  return sealBytes(key, Buffer.from(plain, 'utf8'), binding);
}

function open(key: Buffer, sealed: Buffer, binding: string): string {
  return openBytes(key, sealed, binding).toString('utf8');
}

/**
 * What a person's photo is bound to (5.17c): its household, its person and
 * itself. Sealed under the household key, a photo copied onto another
 * person, or another photo's row, does not open.
 */
export const memberPhotoBinding = (householdId: string, memberId: string, photoId: string) =>
  `member-photo:${householdId}:${memberId}:${photoId}`;

/** What the file key of a photo's upload, on its way, is wrapped for (5.17c). */
export const memberPhotoSourceBinding = (householdId: string, memberId: string, photoId: string) =>
  `member-photo-source:${householdId}:${memberId}:${photoId}`;

/**
 * An email the API asks the worker to send to one address through the
 * operator's mail server (5.20, `mail.to_address`): sealed under a key
 * derived from the master key for this alone, so the job queue — and every
 * backup of it — holds no address and no code. The API seals, the worker
 * opens; bound to its household.
 */
export const OPERATOR_MAIL_KEY_PURPOSE = 'operator-mail-job';
export const operatorMailBinding = (householdId: string) => `mail.to_address:${householdId}`;

/** What sealing adds to the bytes sealed: the nonce before them, the tag after. */
export const SEAL_OVERHEAD = IV_BYTES + TAG_BYTES;

/**
 * Bytes sealed as the values above are (5.17c): AES-256-GCM under a fresh
 * nonce, `iv || ciphertext || tag`, bound to what they are by `binding`, so
 * a blob copied to another row does not open. A person's photo is sealed
 * so, under the household key, bound to `member-photo:<household>:<person>:<photo>`.
 */
export function sealBytes(key: Buffer, plain: Buffer, binding: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(binding, 'utf8'));
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

/**
 * Opens what `sealBytes` sealed, under the same key and binding; anything
 * else — another key, another binding, a byte changed — throws.
 */
export function openBytes(key: Buffer, sealed: Buffer, binding: string): Buffer {
  if (sealed.length < SEAL_OVERHEAD) throw new Error('sealed value is too short');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  d.setAAD(Buffer.from(binding, 'utf8'));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      d.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
      d.final(),
    ]);
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
