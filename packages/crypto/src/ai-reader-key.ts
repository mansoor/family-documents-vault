import { openBound, sealBound } from './master-rotation.js';

/**
 * The API key of the household's AI reader, as an owner sets it in Settings
 * → Reading → AI reader (0.9.0, AIR1): sealed by the API (AES-256-GCM, the
 * household bound in) under a key derived from the master key for this
 * purpose alone, and opened only by the worker, to send it to that reader as
 * a call is made. One of MASTER_SEALED, so rotate-master-key and a restore
 * of an older backup move it as they move the other secrets. Never returned,
 * logged or put in an export.
 */
export const AI_READER_KEY_PURPOSE = 'ai-reader-credentials';

/** Which reader, and where, a key was typed for: bound in with the household. */
export interface AiReaderKeyTarget {
  kind: string;
  /** Null for a reader whose address is fixed (Anthropic). */
  baseUrl: string | null;
}

/**
 * What is bound in: the household, so a value moved to another's row does
 * not open; and the kind and the address it was typed for, so a key kept as
 * the address is changed never goes to the new one.
 */
export const aiReaderKeyAad = (householdId: string, kind: string, baseUrl: string) =>
  `ai-reader:${householdId}\0${kind}\0${baseUrl}`;

export function sealAiReaderKey(
  key: Buffer,
  apiKey: string,
  householdId: string,
  to: AiReaderKeyTarget,
): Buffer {
  return sealBound(
    key,
    Buffer.from(apiKey, 'utf8'),
    aiReaderKeyAad(householdId, to.kind, to.baseUrl ?? ''),
  );
}

export function openAiReaderKey(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  to: AiReaderKeyTarget,
): string {
  return openBound(key, sealed, aiReaderKeyAad(householdId, to.kind, to.baseUrl ?? '')).toString(
    'utf8',
  );
}
