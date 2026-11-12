import { openBound, sealBound } from './master-rotation.js';

/**
 * A share link's sealed copy (0.9.0; the owner's decision of 11 Nov 2026):
 * what the maker of a link was handed as it was made — the link's secret,
 * and the PIN or the password the vault made up — sealed by the API
 * (AES-256-GCM) under a key derived from the master key for this purpose
 * alone, and opened by the API alone, for the account that made the link,
 * once it has confirmed it's them. One of MASTER_SEALED, so
 * rotate-master-key and a restore of an older backup move it as they move
 * the other secrets.
 */
export const SHARE_LINK_COPY_PURPOSE = 'share-link-copies';

/** What a copy holds: the link's secret, and its PIN or made-up password, if it has one. */
export interface ShareLinkCopy {
  token: string;
  pin?: string;
  password?: string;
}

/**
 * What is bound in: the household and the link, so a copy moved onto
 * another link's row, or another household's, does not open.
 */
export const shareLinkCopyAad = (householdId: string, shareId: string) =>
  `share-link:${householdId}\0${shareId}`;

export function sealShareLinkCopy(
  key: Buffer,
  copy: ShareLinkCopy,
  householdId: string,
  shareId: string,
): Buffer {
  const plain: ShareLinkCopy = {
    token: copy.token,
    ...(copy.pin ? { pin: copy.pin } : {}),
    ...(copy.password ? { password: copy.password } : {}),
  };
  return sealBound(
    key,
    Buffer.from(JSON.stringify(plain), 'utf8'),
    shareLinkCopyAad(householdId, shareId),
  );
}

export function openShareLinkCopy(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  shareId: string,
): ShareLinkCopy {
  const plain = JSON.parse(
    openBound(key, sealed, shareLinkCopyAad(householdId, shareId)).toString('utf8'),
  ) as Partial<ShareLinkCopy>;
  if (typeof plain.token !== 'string') throw new Error('a share link copy holds no link');
  return {
    token: plain.token,
    ...(typeof plain.pin === 'string' ? { pin: plain.pin } : {}),
    ...(typeof plain.password === 'string' ? { password: plain.password } : {}),
  };
}
