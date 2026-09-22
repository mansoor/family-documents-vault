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
  features: CapabilityFeatures;
  limits: CapabilityLimits;
  deprecations: Deprecation[];
  branding: { display_name: string };
}
