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
  /** FDV_SHARE_MAX_DAYS: the longest a share link may last (5.18). 90 when not said. */
  shareMaxDays?: number;
  /** FDV_SMTP_URL is set: the operator's mail server, which alone sends a link's code (5.20, A21). */
  operatorMail?: boolean;
}

/**
 * Oldest client this server will talk to. Bumped only with a published
 * deprecation window; see docs/api-changelog.md.
 */
export const MIN_CLIENT_VERSION = '0.0.1';

/**
 * What is going, and in which release (docs/api-changelog.md: four minor
 * releases' notice). The old share routes answer only links made before
 * 0.5.14, the last of which lapses within 90 days (A25); by 0.9.0 they
 * would answer nothing. A reset's and an invitation's token travel in a
 * body since 5.17; the path forms serve the links made before it — an hour
 * for a reset, thirty days at most for an invitation — and go in 0.9.0 too.
 */
export const DEPRECATIONS: Capabilities['deprecations'] = [
  { field: 'GET /api/v1/shared/{token}', removed_in: '0.9.0' },
  { field: 'POST /api/v1/shared/{token}/open', removed_in: '0.9.0' },
  { field: 'GET /api/v1/shared/{token}/content', removed_in: '0.9.0' },
  { field: 'GET /api/v1/password-resets/{token}', removed_in: '0.9.0' },
  { field: 'POST /api/v1/password-resets/{token}', removed_in: '0.9.0' },
  { field: 'GET /api/v1/invitations/{token}', removed_in: '0.9.0' },
  { field: 'POST /api/v1/invitations/{token}/accept', removed_in: '0.9.0' },
];

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
      // 0.5.11: the household's own kinds of document, and the web's editor for them.
      custom_types: true,
      // 0.5.12: collections of documents, each reader given what they may see (5.14).
      collections: true,
      // 0.5.15: a kind reminds from any date it shows (5.16a); said since
      // 0.5.16, when the web's editor for it shipped (5.16b).
      reminder_dates: true,
      // 0.5.19: people's photos, made by the worker; the family sees
      // everyone's, a viewer only their own (5.17c).
      member_photos: true,
      // 5.18: a link until a date and time, to view or to download, so many opens.
      share_options: true,
      // 5.19: a collection shared outside, as its sharer ticked it, checked on every request.
      collection_shares: true,
      // 5.20: a password, and one browser only, on any link; one counter of ten.
      share_second_factor: true,
      // 5.20: an emailed code, through the operator's mail server alone (A21).
      share_email_code: config.operatorMail === true,
      // 5.24: an owner removes a document in the Trash for good (D1).
      remove_for_good: true,
      // 5.25: a person's details changed, made to the version seen; the
      // owner's view of a sign-in, for an owner with two-step sign-in (A54).
      member_edit: true,
      // 5.21 and 5.23: asking somebody outside to send documents, and
      // looking at what they sent before it is filed.
      upload_requests: true,
      // 5.26: people's identity details, sealed; who sees them, wider only
      // after 72 hours' notice (A34).
      member_identity: true,
      // 5.28: an owner locks somebody's sign-in, and unlocks it (A51, A54);
      // after a restore every sign-in but the owners' waits for an owner.
      member_admin: true,
      // 5.30: an owner signs somebody out everywhere, a co-owner too (A53);
      // a role change says what else it did.
      sign_out_everywhere: true,
    },
    limits: {
      max_upload_bytes: config.maxUploadBytes,
      max_members: null,
      max_storage_bytes: null,
      // 5.18 review: a client offers only ends the vault will take.
      share_max_days: config.shareMaxDays ?? 90,
    },
    deprecations: DEPRECATIONS,
    branding: { display_name: config.displayName },
    ...(config.instanceId ? { instance_id: config.instanceId } : {}),
  };
}
