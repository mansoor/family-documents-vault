import { API_VERSION, PRODUCT_ID, type Capabilities, type Edition } from '@fdv/shared';

export interface CapabilityConfig {
  serverVersion: string;
  edition: Edition;
  displayName: string;
  maxUploadBytes: number;
  setupRequired: boolean;
  /** Web Push keys are configured, so the vault can notify devices. */
  pushEnabled: boolean;
  /** This installation's identifier (migration 0021); null before it exists. */
  instanceId: string | null;
}

/**
 * Oldest client this server will talk to. Bumped only with a published
 * deprecation window; see docs/api-changelog.md.
 */
export const MIN_CLIENT_VERSION = '0.0.1';

/**
 * Builds the capability document from server configuration.
 *
 * Every feature starts `false` and is switched on by the iteration that ships
 * it, so a client can never be told about something the server cannot do —
 * and is switched on when it ships, so a client that hides what is not
 * offered does not hide something that is. Until 0.4.4 `push` and
 * `share_links` said false long after both had shipped.
 */
export function buildCapabilities(config: CapabilityConfig): Capabilities {
  return {
    product: PRODUCT_ID,
    server_version: config.serverVersion,
    api_version: API_VERSION,
    min_client_version: MIN_CLIENT_VERSION,
    edition: config.edition,
    protection_mode: 'standard',
    setup_required: config.setupRequired,
    features: {
      passkeys: true,
      private_mode: false,
      email_ingest: false,
      // "This vault can send Web Push": the same fact as push-key's `enabled`.
      push: config.pushEnabled,
      share_links: true,
      bulk_import: false,
      multi_household: false,
      idempotent_capture: true,
      capture_metadata: true,
      issued_by: true,
      page_previews: true,
      offline_essentials: true,
      unified_push: config.pushEnabled,
    },
    limits: {
      max_upload_bytes: config.maxUploadBytes,
      max_members: null,
      max_storage_bytes: null,
    },
    deprecations: [],
    branding: { display_name: config.displayName },
    ...(config.instanceId ? { instance_id: config.instanceId } : {}),
  };
}
