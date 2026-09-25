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
