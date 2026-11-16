import { openBound, sealBound } from './master-rotation.js';

/**
 * A request to send documents' sealed copy (0.9.0, LK; the owner's decision
 * of 15 Nov 2026), as a share link's (share-link-copy.ts): what whoever
 * asked was handed as it was made — the link's secret, and the password the
 * vault made up — sealed by the API (AES-256-GCM) under a key derived from
 * the master key for this purpose alone, and opened by the API alone, for
 * the account that made the request, once it has confirmed it's them. One
 * of MASTER_SEALED, so rotate-master-key and a restore of an older backup
 * move it as they move the other secrets.
 */
export const UPLOAD_REQUEST_COPY_PURPOSE = 'upload-request-copies';

/** What a copy holds: the link's secret, and its made-up password, if it has one. */
export interface UploadRequestCopy {
  token: string;
  password?: string;
}

/**
 * What is bound in: the household and the request, so a copy moved onto
 * another request's row, or another household's, does not open.
 */
export const uploadRequestCopyAad = (householdId: string, requestId: string) =>
  `upload-request:${householdId}\0${requestId}`;

export function sealUploadRequestCopy(
  key: Buffer,
  copy: UploadRequestCopy,
  householdId: string,
  requestId: string,
): Buffer {
  const plain: UploadRequestCopy = {
    token: copy.token,
    ...(copy.password ? { password: copy.password } : {}),
  };
  return sealBound(
    key,
    Buffer.from(JSON.stringify(plain), 'utf8'),
    uploadRequestCopyAad(householdId, requestId),
  );
}

export function openUploadRequestCopy(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  requestId: string,
): UploadRequestCopy {
  const plain = JSON.parse(
    openBound(key, sealed, uploadRequestCopyAad(householdId, requestId)).toString('utf8'),
  ) as Partial<UploadRequestCopy>;
  if (typeof plain.token !== 'string') throw new Error('a request copy holds no link');
  return {
    token: plain.token,
    ...(typeof plain.password === 'string' ? { password: plain.password } : {}),
  };
}
