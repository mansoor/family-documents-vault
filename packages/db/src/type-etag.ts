import { createHash } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { Schema } from './client.js';

/** A kind of document as a household has it: a row of effective_document_type. */
export type EffectiveType = Selectable<Schema['effective_document_type']>;

/**
 * A type's ETag (0.5.10): everything it says, as the household has it now.
 * Any change to it — the household's, or a release's to a built-in — makes
 * a new one, and an edit made to an older one is refused.
 *
 * Here beside the schema, not in the API, so that the migration test can
 * hold every existing kind to the ETag it had before a migration (0038).
 *
 * The date it reminds from (0038) is in it only when that is a date field:
 * a kind reminding from Expires, or from nothing, says what `expiry_driver`
 * and `reminder_leads` already said, so every kind kept its ETag at the
 * upgrade and nobody was asked to load it again.
 */
export function typeEtag(t: EffectiveType): string {
  const seed = JSON.stringify([
    t.key,
    t.label,
    t.category,
    t.fields,
    t.expiry_driver,
    t.reminder_leads,
    t.usually_essential,
    t.default_visibility,
    t.core,
    t.short_label,
    t.issuer_noun,
    t.hidden,
    t.archived_at ? new Date(t.archived_at).toISOString() : null,
    t.pack_version,
    t.updated_at ? new Date(t.updated_at).toISOString() : null,
    // Absent from a row read before 0038, as null: the same ETag.
    ...(t.remind_from && t.remind_from !== 'expires' ? [t.remind_from, t.remind_leads] : []),
  ]);
  return `"${createHash('sha256').update(seed).digest('hex').slice(0, 16)}"`;
}
