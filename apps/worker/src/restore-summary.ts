import path from 'node:path';
import type { RestoreReport } from './jobs/restore.js';

/**
 * What restore-backup says when it is done (cli.ts): what came back, and
 * everything the restore undid that somebody has to know about.
 */
export function restoreSummary(file: string, r: RestoreReport): string {
  const made = madeAt(file);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const lines = [
    `Restored ${path.basename(file)}${made ? `, made ${made}` : ''}:`,
    `  ${plural(r.households, 'household')}, ${plural(r.members, 'person', 'people')}, ` +
      `${plural(r.documents, 'document')} (${plural(r.versions, 'version')}); database schema ${r.schema}.`,
    '',
    'Everything since the backup was made is undone, so:',
    `  - Everybody has been signed out (${plural(r.sessionsEnded, 'session')}). Each person signs in`,
    '    with the password they had when the backup was made.',
    '  - Passkeys and two-step sign-in are as they were then too. Anybody who removed a',
    '    passkey or reset two-step sign-in since does it again, in Settings.',
  ];
  if (r.rekeyed) {
    const secrets = Object.values(r.rekeyed.resealed).reduce((n, c) => n + c, 0);
    lines.push(
      '  - It was made before the master key was rotated. What it holds is now under the',
      `    current key, as the vault's own is: ${plural(r.rekeyed.rewrapped, 'scope key')} and ` +
        `${plural(secrets, 'secret')} (two-step`,
      '    sign-in, storage and mail) were moved across.',
    );
  }
  if (r.ownerChangesWithdrawn > 0) {
    lines.push(
      `  - ${plural(r.ownerChangesWithdrawn, 'request')} to change who is an owner ` +
        `${r.ownerChangesWithdrawn === 1 ? 'was' : 'were'} ended, so nothing changed;`,
      '    an owner can ask again if it still stands, and everybody is told afresh.',
    );
  }
  if (r.linksPaused > 0) {
    lines.push(
      `  - ${plural(r.linksPaused, 'share link')} ${r.linksPaused === 1 ? 'is' : 'are'} paused, ` +
        'so a link taken back since the backup',
      '    does not work again. An owner turns back on the ones still wanted, in',
      '    After a restore, on Home.',
    );
  }
  if (r.requestsPaused > 0) {
    lines.push(
      `  - ${plural(r.requestsPaused, 'request')} to send documents ` +
        `${r.requestsPaused === 1 ? 'is' : 'are'} paused, so one taken back since the backup`,
      '    does not work again. An owner turns back on the ones still wanted, in',
      '    After a restore, on Home.',
    );
  }
  if (r.signInsPaused > 0) {
    lines.push(
      `  - ${plural(r.signInsPaused, 'sign-in')} ${r.signInsPaused === 1 ? 'is' : 'are'} paused — ` +
        'every one but the owners’ — since the backup cannot',
      '    know of a lock, or a sign-in taken away, since it was made. An owner turns',
      '    each back on, one tap each, in After a restore, on Home.',
    );
  }
  if (r.locksKept > 0) {
    lines.push(
      `  - ${plural(r.locksKept, 'sign-in')} locked when the backup was made ` +
        `${r.locksKept === 1 ? 'stays' : 'stay'} locked until an owner`,
      '    unlocks it: a lock that would have ended by itself no longer does.',
    );
  }
  if (r.incomingDropped > 0) {
    lines.push(
      `  - ${plural(r.incomingDropped, 'file')} sent through a request and waiting when the backup ` +
        `was taken ${r.incomingDropped === 1 ? 'is' : 'are'} gone:`,
      '    filed, refused or removed since. Nothing of them is left to look at.',
    );
  }
  if (r.photosUnfinished > 0) {
    lines.push(
      `  - ${plural(r.photosUnfinished, 'photo')} still being made when the backup was taken ` +
        `${r.photosUnfinished === 1 ? 'was' : 'were'} not finished;`,
      '    choose it again on the person’s profile.',
    );
  }
  if (r.purgeRequestsCleared > 0) {
    lines.push(
      `  - ${plural(r.purgeRequestsCleared, 'request')} to remove a document for good ` +
        `${r.purgeRequestsCleared === 1 ? 'was' : 'were'} ended, so whoever added it`,
      '    keeps it: an owner asks again if it still stands, and they are told afresh.',
    );
  }
  if (r.noticesWithdrawn > 0) {
    lines.push(
      `  - ${plural(r.noticesWithdrawn, 'notice')} still waiting ${r.noticesWithdrawn === 1 ? 'was' : 'were'} ` +
        'withdrawn, so a wider audience for identity',
      '    details does not come back: an owner asks again, and everybody is told afresh.',
    );
  }
  for (const a of r.identityAudiences) {
    const was = { adults: 'all adults', family: 'everyone in the family' }[a.was] ?? a.was;
    lines.push(
      `  - Who can see identity details in household ${a.household_id} went back to`,
      `    the owners and each person (it was ${was}). An owner can widen it again in`,
      '    Settings → Family; that waits 72 hours, while everybody is told.',
    );
  }
  if (r.exportsExpired > 0) {
    lines.push(
      `  - ${plural(r.exportsExpired, 'export')} that could still be downloaded ` +
        `${r.exportsExpired === 1 ? 'was' : 'were'} ended: each held what its maker`,
      '    could see then. Whoever needs one makes it again, in Settings.',
    );
  }
  if (r.filesRemoved.length > 0) {
    const documents = [...new Set(r.filesRemoved.map((f) => f.document_id))];
    lines.push(
      `  - ${plural(documents.length, 'document')} had ${documents.length === 1 ? 'its file' : 'their files'} ` +
        'removed for good after the backup was made. The record is back, the',
      '    file is not: each says "The file was removed for good" when it is opened.',
      '    If a file is put back later, run recheck-files and it opens again.',
      ...documents.map((d) => `      ${d}`),
    );
  }
  if (r.filesUnchecked > 0) {
    lines.push(
      `  - ${plural(r.filesUnchecked, 'file')} could not be looked for, and ${r.filesUnchecked === 1 ? 'is' : 'are'} not marked removed:`,
      ...r.filesUncheckedWhy.map((why) => `      ${why}`),
      '    Once the files are in place, their documents open as before.',
    );
  }
  if (r.openInvitations > 0) {
    lines.push(
      `  - ${plural(r.openInvitations, 'invitation')} ${r.openInvitations === 1 ? 'is' : 'are'} ` +
        'open. Anybody who joined since the backup',
      '    joins again with the same invitation, or is invited afresh.',
    );
  }
  lines.push(
    '',
    'Now start the vault:  docker compose up -d',
    '(with the same -f files you always use, such as docker-compose.tls.yml)',
  );
  return lines.join('\n');
}

/** "fdv-2026-09-24T02-30-00-123Z.sql.enc" was made at 2026-09-24 02:30 UTC. */
function madeAt(file: string): string | null {
  const m = /fdv-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)/.exec(path.basename(file));
  return m ? `${m[1]} ${m[2]}:${m[3]} UTC` : null;
}
