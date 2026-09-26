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
}

export interface CapabilityLimits {
  max_upload_bytes: number;
  /** `null` means unlimited, which is the self-hosted default. */
  max_members: number | null;
  /** `null` means unlimited, which is the self-hosted default. */
  max_storage_bytes: number | null;
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
