/**
 * The capability document: the first thing any client fetches from a server,
 * unauthenticated, before deciding what to show.
 *
 * Shape is part of the v1 API contract. Fields are only ever added; clients
 * must ignore fields they do not recognise.
 */

export const API_VERSION = 1 as const;
export const PRODUCT_ID = 'family-document-vault' as const;

export type Edition = 'self_hosted' | 'hosted';
export type ProtectionMode = 'standard' | 'private';

export interface CapabilityFeatures {
  passkeys: boolean;
  private_mode: boolean;
  email_ingest: boolean;
  push: boolean;
  share_links: boolean;
  bulk_import: boolean;
  multi_household: boolean;
  /**
   * Uploads are reserve-then-commit (0.4.8): a retry with the same
   * Idempotency-Key never makes a second document, overlapping tries get
   * 409 upload_in_progress, and GET /uploads/{key} says what became of one.
   */
  idempotent_capture: boolean;
  /**
   * POST /capture takes the card's details as a `metadata` field sent before
   * the file (0.4.9): the document is made complete, and wrapped for the
   * right people, from its first byte.
   */
  capture_metadata: boolean;
  /**
   * Documents carry `issued_by` (0.4.10): on views, edits and captures, in
   * search (matched, and filtered by `issued_by`), GET /issuers and
   * GET /documents/{id}/issuer-suggestions. An older vault refuses the
   * field, so send it only when this is on.
   */
  issued_by: boolean;
  /**
   * The vault draws each version's pages (0.4.12): GET
   * /versions/{id}/pages/{n} serves them as JPEGs, `preview_pages` on a
   * version says how many, and an Essential's are drawn ahead of time.
   */
  page_previews: boolean;
  /**
   * A phone may keep the Essentials for offline use (0.4.13): an offline
   * grant (POST /offline/grant, with the password), the complete set
   * (GET /offline/essentials), the pages to fill it, and the opens it
   * reports afterwards (POST /offline/opens).
   */
  offline_essentials: boolean;
  /**
   * The phone app can have its notifications through its own UnifiedPush
   * distributor (4.13). The same fact as `push`: the VAPID keys are set.
   */
  unified_push?: boolean;
  /**
   * The household keeps kinds of document of its own and changes the
   * built-in ones (0.5.11): created, changed, hidden and archived through
   * /document-types and /document-attributes by owners and adults, and
   * offered to everybody who files documents, each under one of the twelve
   * categories. Absent from older vaults, which have the built-ins only.
   */
  custom_types?: boolean;
  /**
   * Collections of documents (0.5.12): /collections, their items and
   * GET /documents/{id}/collections. Owners, adults and teens make them; each
   * reader is given only the documents in a collection they could see anyway.
   * Absent from older vaults.
   */
  collections?: boolean;
  /**
   * A kind reminds from any date it shows (0.5.15): `remind_from` and
   * `remind_leads` on kinds, `source` and `about` on reminders,
   * `reminders_by_source` on a kind's impact, the built-in Due date. The
   * server has them from 0.5.15, where it says `false`, and says `true`
   * from 0.5.16, when the web's editor for them shipped; a client offers
   * them only when this is true.
   * Absent from older vaults.
   */
  reminder_dates?: boolean;
  /**
   * People have photos (0.5.19): `photo`, `photo_status` and
   * `can_change_photo` on members, and PUT, DELETE and GET
   * /members/{id}/photo. The family sees everyone's, a viewer only their
   * own. Absent from older vaults, where a client shows initials.
   */
  member_photos?: boolean;
  /**
   * A link's options (5.18): POST /documents/{id}/share takes `expires_at`
   * (a date and time), `permission` (`view` or `download`), `max_opens` and
   * `max_downloads`; a link to view serves its pages at
   * /shared/items/{id}/pages/{n} and never the file. Absent from older
   * vaults, which take `expires_in_days` only; send the rest only when this
   * is true.
   */
  share_options?: boolean;
  /**
   * A collection can be shared outside the family (5.19): GET
   * /collections/{id}/share-preview, POST /collections/{id}/shares (always
   * with step-up), links to collections in GET /shares, and the recipient's
   * page giving each document the link still gives. Absent from older
   * vaults.
   */
  collection_shares?: boolean;
  /**
   * A link can ask for more than itself (5.20): a password the vault makes
   * up (`with_password`) or one the sharer types (`password`), and to open
   * in one browser only (`this_device_only`); every failed PIN, password or
   * code uses up the link's one counter of ten. Absent from older vaults,
   * which take `with_pin` alone.
   */
  share_second_factor?: boolean;
  /**
   * A link can ask for a code emailed to an address the sharer typed
   * (5.20, `code_email`; `POST /shared/code` sends it). Only through the
   * mail server of whoever runs the vault (FDV_SMTP_URL, A21), never the
   * household's own: false without one, and a client hides the option,
   * saying why (`SHARE_CODE_UNAVAILABLE`). Absent from older vaults.
   */
  share_email_code?: boolean;
  /**
   * An owner can remove a document in the Trash for good (5.24): POST
   * /documents/{id}/purge, always with step-up — at once for one they filed
   * or that is theirs, anybody else's 24 hours after asking. Absent from
   * older vaults, where nothing is ever removed.
   */
  remove_for_good?: boolean;
  /**
   * A person's details can be changed (5.25): PATCH /members/{id} with
   * If-Match on `version` (`409 conflict` when it moved on), `version` and
   * `can_edit` on members; and an owner's read-only view of somebody's
   * sign-in, GET /members/{id}/account, which asks an owner for two-step
   * sign-in or a passkey (A54). Absent from older vaults, which change
   * nobody's details.
   */
  member_edit?: boolean;
  /**
   * Somebody outside the family can be asked to send documents (5.21), and
   * what they send is looked at before it is filed (5.23): /upload-requests,
   * the sender's /drop routes, and /incoming — the files waiting, their
   * previews, their content, filing one and refusing one. For owners and
   * adults. Absent from older vaults.
   */
  upload_requests?: boolean;
  /**
   * People's identity details, sealed (5.26): GET, PUT /members/{id}/identity
   * and POST …/identity/reveal, a shared part and an Only me part each with
   * its own version; and GET, PUT /household/identity-audience (A34), wider
   * only after 72 hours' notice. Absent from older vaults, which keep none.
   */
  member_identity?: boolean;
  /**
   * An owner can lock somebody's sign-in and unlock it (5.28): POST and
   * DELETE /members/{id}/lock, owner powers (A54); a locked person's sign-in
   * is refused with `403 membership_suspended` once their credentials are
   * proven, and their sessions end with the reason `suspended`. After a
   * restore every sign-in but the owners' is paused until an owner turns it
   * back on (POST /members/{id}/resume; GET /after-restore's `sign_ins`).
   * Absent from older vaults, which lock nobody.
   */
  member_admin?: boolean;
  /**
   * An owner can sign somebody out everywhere (5.30, A53): DELETE
   * /members/{id}/sessions, an owner power (A54); a co-owner too, who is
   * told. A role change says what else it did (`RoleChangeResult.effects`):
   * Essentials on their phones ended, their requests closed, their exports
   * ended. Absent from older vaults.
   */
  sign_out_everywhere?: boolean;
  /**
   * An owner limits what a viewer can see (5.33, D6, A56–A59): PUT and
   * DELETE /members/{id}/access, an owner power (A54, `limit_access`);
   * GET /members/{id}/access/preview counts what a grant not yet saved
   * gives. An invitation for a viewer carries `restriction` — from an
   * adult it must (A27). `/me.restriction` tells a restricted viewer what
   * they can see. Absent from older vaults, which limit nobody this way.
   */
  access_restrictions?: boolean;
  /**
   * Someone outside the family with a sign-in of their own (5.34, D4, A28):
   * an invitation with `kind: 'guest'` — always a viewer's, always limited,
   * with `access_expires_at` within a year (`limits.guest_max_days`). A guest
   * is `role: 'viewer'` and `kind: 'guest'` on /me and GET /members; owners
   * list them with GET /members?kind=guest and renew them with POST
   * /members/{id}/renew (`renew_guest`). Absent from older vaults.
   */
  guests?: boolean;
  /**
   * What a document's pages say about it (5.37, A44):
   * GET /documents/{id}/suggestions proposes its kind, whose it is, when it
   * was issued and when it runs out, its number and who issued it — each
   * with a confidence and the cue it came from, only for fields it has no
   * value for, and only above `PROPOSAL_THRESHOLDS`. For whoever may change
   * the document; offered, never filled in. Absent from older vaults, which
   * have GET /documents/{id}/issuer-suggestions only (it stays).
   */
  detail_suggestions?: boolean;
  /**
   * GET /documents sorts by a column (Phase 6, R2, `DOCUMENT_SORTS`): `sort`
   * by title, kind, person, issued, expires, status, visibility,
   * collections or location, with `direction`, and filters for nobody's
   * (`member_id=none`), a collection (`collection_id`, or `none`) and where
   * the original is kept (`location`); a page carries `total`, and each
   * document its `collections`. A sort or filter by location is for whoever
   * sees locations (422 for anybody else). Absent from older vaults, which
   * refuse those sorts.
   */
  document_table?: boolean;
}

export interface CapabilityLimits {
  max_upload_bytes: number;
  /** `null` means unlimited, which is the self-hosted default. */
  max_members: number | null;
  /** `null` means unlimited, which is the self-hosted default. */
  max_storage_bytes: number | null;
  /**
   * The longest a share link may last, in days (5.18: FDV_SHARE_MAX_DAYS,
   * 90 unless the operator shortens it). An `expires_at` past it is refused.
   * Absent from older vaults, which take 90.
   */
  share_max_days?: number;
  /** The longest a guest's sign-in lasts before an owner renews it, in days (5.34, A28). */
  guest_max_days?: number;
}

export interface Deprecation {
  field: string;
  removed_in: string;
}

export interface Capabilities {
  product: typeof PRODUCT_ID;
  server_version: string;
  api_version: typeof API_VERSION;
  min_client_version: string;
  edition: Edition;
  protection_mode: ProtectionMode;
  /** True until the first-run wizard has created the household. */
  setup_required: boolean;
  features: CapabilityFeatures;
  limits: CapabilityLimits;
  deprecations: Deprecation[];
  branding: { display_name: string };
  /**
   * This installation, as a random identifier made once and never changed
   * (0.4.4). A client that approved a vault at an address can tell whether
   * the same vault still answers there. Absent from older servers.
   */
  instance_id?: string;
}
