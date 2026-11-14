import { plainName, shareEndWords } from '@fdv/shared';

/**
 * The email that carries a share link to its recipient (0.9.0; the owner's
 * decision of 13 Nov 2026), sent through the operator's mail server alone
 * (A21) as a link's code is.
 *
 * Plain text, and short: whose vault it is from and who shared it, "a
 * document" or "a collection" — never its title, which can say a great deal
 * (H2's spirit) — the sharer's own short message if they wrote one, the
 * link, when it stops working, that a PIN or password comes separately, and
 * why they got it. Never the PIN, the password or a code: those go another
 * way, or (a code) in an email of their own when the link is opened.
 */
export interface LinkEmailInput {
  householdName: string;
  sharedBy: string | null;
  collection: boolean;
  link: string;
  expiresAt: Date;
  timezone: string;
  /** The sharer's own words, already made plain (shareLinkMessage). */
  message: string | null;
  /** How the link's code goes, when it asks for one: said, never the code. */
  code: 'email' | 'sms' | null;
}

export function linkEmail(e: LinkEmailInput): { subject: string; text: string } {
  // Names are anybody's typing: said plainly, with no web address in them
  // and nothing hidden or turned round (plainName, the review of
  // 0.9.0-dev.39), or not at all.
  const household = plainName(e.householdName);
  const who = plainName(e.sharedBy);
  const what = e.collection ? 'a collection of documents' : 'a document';
  const subject = who
    ? `${who} has shared ${what} with you`
    : `${what.charAt(0).toUpperCase()}${what.slice(1)} has been shared with you`;
  const lines = [
    `${who ?? 'Somebody'}${household ? ` from ${household}` : ''} has shared ${what} with you, from their family's document vault.`,
    '',
  ];
  if (e.message) {
    lines.push(`${who ?? 'They'} wrote:`, ...e.message.split('\n').map((l) => `  ${l}`), '');
  }
  lines.push(
    'Open it here:',
    e.link,
    '',
    `The link stops working on ${shareEndWords(e.expiresAt, e.timezone)}.`,
    '',
    'If it asks for a PIN or password, the person who sent it will give it to you separately.',
  );
  if (e.code) {
    lines.push(
      e.code === 'sms'
        ? 'If it asks for a code, one is texted to the mobile number the person who sent it chose, when the link is opened.'
        : 'If it asks for a code, one is emailed on its own to the address the person who sent it chose, when the link is opened.',
    );
  }
  lines.push(
    '',
    '--',
    `You are getting this because ${who ?? 'somebody'}${household ? ` at ${household}` : ''} typed your address to send you this link. ` +
      'It opens only what they shared, and nothing else. If you were not expecting it, you can ignore this email.',
    '',
  );
  return { subject, text: lines.join('\n') };
}
