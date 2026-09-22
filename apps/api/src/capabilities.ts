import { API_VERSION, PRODUCT_ID, type Capabilities, type Edition } from '@fdv/shared';

export interface CapabilityConfig {
  serverVersion: string;
  edition: Edition;
  displayName: string;
  maxUploadBytes: number;
  setupRequired: boolean;
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
 * it, so a client can never be told about something the server cannot do.
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
      passkeys: false,
      private_mode: false,
      email_ingest: false,
      push: false,
      share_links: false,
      bulk_import: false,
      multi_household: false,
    },
    limits: {
      max_upload_bytes: config.maxUploadBytes,
      max_members: null,
      max_storage_bytes: null,
    },
    deprecations: [],
    branding: { display_name: config.displayName },
  };
}
