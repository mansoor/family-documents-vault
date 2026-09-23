import { createApi, createHttp, type ResponseLike, type UploadBody } from '@fdv/client';
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

export { ApiRequestError, NetworkError, isSessionOver } from '@fdv/client';
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
  RoleChangeResult,
  SearchHit,
  SearchResult,
  SessionRow,
  Share,
  SharedDocument,
  SharePreview,
  SmtpInput,
  SmtpProvider,
  SmtpView,
  StepUpState,
  TestOutcome,
  Tokens,
  VaultRow,
} from '@fdv/shared';

const client = createApi(
  createHttp({
    // Same origin: nginx serves the app and proxies /api. The global fetch
    // is looked up on every call, so a test can stand in for it.
    baseUrl: '',
    fetch: (url, init) => globalThis.fetch(url, init as RequestInit),
  }),
);

function fileForm(file: File): UploadBody {
  const form = new FormData();
  form.append('file', file, file.name);
  return { kind: 'form', form };
}

/** In a browser, the response is a real Response, and so has a Blob. */
const blobOf = async (res: Promise<ResponseLike>): Promise<Blob> =>
  ((await res) as unknown as Response).blob();

export const api = {
  ...client,
  upload: (token: string, documentId: string, file: File, idempotencyKey: string) =>
    client.upload(token, documentId, fileForm(file), idempotencyKey),
  capture: (token: string, file: File, idempotencyKey: string) =>
    client.capture(token, fileForm(file), idempotencyKey),
  content: (token: string, versionId: string) => blobOf(client.content(token, versionId)),
  thumbnail: (token: string, versionId: string) => blobOf(client.thumbnail(token, versionId)),
  exportContent: (token: string, id: string) => blobOf(client.exportContent(token, id)),
  passkeyRegisterChallenge: (token: string) =>
    client.passkeyRegisterChallenge(
      token,
    ) as unknown as Promise<PublicKeyCredentialCreationOptionsJSON>,
  passkeyChallenge: (email?: string) =>
    client.passkeyChallenge(email) as unknown as Promise<PublicKeyCredentialRequestOptionsJSON>,
};
