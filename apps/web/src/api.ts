import { createApi, createHttp, type ResponseLike, type UploadBody } from '@fdv/client';
import { heardFamilyZone } from './family-zone-store.js';
import { heardLocked } from './session-lock.js';
import {
  activityCsvCapped,
  BACKGROUND_HEADER,
  REFRESH_COOKIE_HEADER,
  REFRESH_COOKIE_MODE,
  type ActivityExportAsk,
  type CaptureMetadata,
  type PhotoCrop,
} from '@fdv/shared';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

/**
 * The web app's API client: `@fdv/client`, the one the phone uses too,
 * with the few things only a browser has — a `File` to upload and a
 * `Blob` to hand to the page — wrapped around it. Method names and
 * arguments are what they always were, so no screen had to change.
 */

export { ApiRequestError, NetworkError, isSessionLocked, isSessionOver } from '@fdv/client';
export type { Params } from '@fdv/client';
export type {
  CaptureResult,
  Counts,
  CreatedInvitation,
  CreatedShare,
  DeviceRow,
  DocumentInput,
  ExportRow,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  MfaChallenge,
  NewVault,
  OwnerChange,
  Page,
  PasskeyView,
  Preferences,
  Profile,
  Provider,
  PushKey,
  ResetPreview,
  RevealedShare,
  RoleChangeResult,
  SearchHit,
  SearchResult,
  SessionRow,
  Share,
  SharedDocument,
  SharedItem,
  SharedSession,
  ShareLinkPreview,
  SharePreview,
  SmtpInput,
  SmtpProvider,
  SmtpView,
  StepUpState,
  TestOutcome,
  Tokens,
  VaultRow,
} from '@fdv/shared';

/** The web's client, and (`background`) one whose every request says the page made it by itself. */
const clientFor = (background: boolean) =>
  createApi(
    createHttp({
      // Same origin: nginx serves the app and proxies /api. The global fetch
      // is looked up on every call, so a test can stand in for it.
      baseUrl: '',
      // Any answer `423 session_locked` (0.9.0-dev.86), whichever screen
      // asked, shows the lock screen (session-lock.ts): only a locked session
      // is ever answered 423.
      fetch: async (url, init) => {
        const res = await globalThis.fetch(url, init as RequestInit);
        if (res.status === 423) heardLocked();
        return res;
      },
      // The refresh token in an HttpOnly cookie, never where script on the
      // page can read it (0.9.0): asked for on every request, so every
      // sign-in, refresh and invitation accepted gives it so. And a request
      // the page makes by itself — a count, a check on a timer — says so
      // (0.9.0-dev.87): the vault does not count it as somebody using it.
      headers: () => ({
        [REFRESH_COOKIE_HEADER]: REFRESH_COOKIE_MODE,
        ...(background ? { [BACKGROUND_HEADER]: '1' } : {}),
      }),
    }),
  );

const client = clientFor(false);

/**
 * The same calls, made by the page by itself (0.9.0-dev.87): counts it keeps
 * up to date, checks on a timer, who is signed in. Never for anything
 * somebody did — that is what keeps the vault unlocked while they use it.
 */
export const quiet = clientFor(true);

function fileForm(file: File): UploadBody {
  const form = new FormData();
  form.append('file', file, file.name);
  return { kind: 'form', form };
}

/** In a browser, the response is a real Response, and so has a Blob. */
const blobOf = async (res: Promise<ResponseLike>): Promise<Blob> =>
  ((await res) as unknown as Response).blob();

/** The name a download's Content-Disposition gives (`filename*=UTF-8''…`), or null. */
export function dispositionName(header: string | null): string | null {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '');
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** An answer that says the family's zone, heard on its way past (family-zone-store.ts). */
const hearZone = async <T extends { timezone?: string | null }>(answer: Promise<T>): Promise<T> => {
  const got = await answer;
  heardFamilyZone(got?.timezone);
  return got;
};

export const api = {
  ...client,
  // The family's zone, whichever answer says it (the TZ review): every
  // screen moves to the newest the tab has had.
  profile: (token: string) => hearZone(client.profile(token)),
  updateProfile: (token: string, body: Parameters<typeof client.updateProfile>[1]) =>
    hearZone(client.updateProfile(token, body)),
  householdTimezone: (token: string) => hearZone(client.householdTimezone(token)),
  setHouseholdTimezone: (token: string, timezone: string | null) =>
    hearZone(client.setHouseholdTimezone(token, timezone)),
  upload: (token: string, documentId: string, file: File, idempotencyKey: string) =>
    client.upload(token, documentId, fileForm(file), idempotencyKey),
  /** One file and, since 0.4.9, the card's details, sent ahead of it. */
  capture: (token: string, file: File, idempotencyKey: string, metadata?: CaptureMetadata) =>
    client.capture(
      token,
      {
        file: { kind: 'blob', blob: file, filename: file.name },
        ...(metadata ? { metadata } : {}),
      },
      idempotencyKey,
    ),
  content: (token: string, versionId: string) => blobOf(client.content(token, versionId)),
  thumbnail: (token: string, versionId: string) => blobOf(client.thumbnail(token, versionId)),
  /** One page as the vault drew it (0.4.12). */
  page: (token: string, versionId: string, n: number) => blobOf(client.page(token, versionId, n)),
  exportContent: (token: string, id: string) => blobOf(client.exportContent(token, id)),
  /**
   * The activity log as CSV (0.9.0-dev.82): the file as the vault wrote it,
   * byte-order mark and all, the name it gives it, and whether it stopped at
   * its cap (its last row says so).
   */
  activityCsv: async (token: string, ask: ActivityExportAsk) => {
    const res = await client.activityCsv(token, ask);
    const bytes = await res.arrayBuffer();
    return {
      blob: new Blob([bytes], { type: 'text/csv;charset=utf-8' }),
      filename: dispositionName(res.headers.get('content-disposition')),
      // Read whole: only its last record, alone, says it stopped short.
      capped: activityCsvCapped(new TextDecoder().decode(bytes)),
    };
  },
  /** A page the vault drew of a file sent in (5.23), and a copy of the file itself. */
  incomingPage: (token: string, id: string, n: number) => blobOf(client.incomingPage(token, id, n)),
  incomingContent: (token: string, id: string) => blobOf(client.incomingContent(token, id)),
  /** A page the vault drew of a batch's item (I1): its first, for the row's picture. */
  batchItemPage: (token: string, batchId: string, itemId: string, n: number) =>
    blobOf(client.batchItemPage(token, batchId, itemId, n)),
  /** A person's photo (0.5.19): the square the vault made, as a Blob. */
  memberPhoto: (token: string, memberId: string, photoId: string) =>
    blobOf(client.memberPhoto(token, memberId, photoId)),
  /** A picture chosen for a person, and the part of it to show: the crop goes first. */
  setMemberPhoto: (token: string, memberId: string, file: File, crop: PhotoCrop | null) =>
    client.setMemberPhoto(token, memberId, {
      file: { kind: 'blob', blob: file, filename: file.name || 'photo' },
      crop,
    }),
  passkeyRegisterChallenge: (token: string) =>
    client.passkeyRegisterChallenge(
      token,
    ) as unknown as Promise<PublicKeyCredentialCreationOptionsJSON>,
  passkeyChallenge: (email?: string) =>
    client.passkeyChallenge(email) as unknown as Promise<PublicKeyCredentialRequestOptionsJSON>,
};
