import { describe, expect, it } from 'vitest';
import type { RestoreReport } from './jobs/restore.js';
import { restoreSummary } from './restore-summary.js';

/** A restore that undid nothing, but for what each test puts in. */
function report(over: Partial<RestoreReport> = {}): RestoreReport {
  return {
    schema: 60,
    households: 1,
    members: 3,
    documents: 12,
    versions: 14,
    rekeyed: null,
    sessionsEnded: 2,
    ownerChangesWithdrawn: 0,
    linksPaused: 0,
    requestsPaused: 0,
    photosUnfinished: 0,
    purgeRequestsCleared: 0,
    noticesWithdrawn: 0,
    identityAudiences: [],
    exportsExpired: 0,
    signInsPaused: 0,
    locksKept: 0,
    openInvitations: 0,
    filesRemoved: [],
    filesUnchecked: 0,
    filesUncheckedWhy: [],
    incomingDropped: 0,
    ...over,
  };
}

describe('what restore-backup says when it is done', () => {
  it('sends an owner to After a restore on Home, where the web keeps it since R1, not to Settings', () => {
    const words = restoreSummary(
      'fdv-2026-09-24T02-30-00-123Z.sql.enc',
      report({ linksPaused: 2, requestsPaused: 1, signInsPaused: 1 }),
    ).replace(/\s+/g, ' ');
    expect(words).toContain(
      '2 share links are paused, so a link taken back since the backup does not work again. An owner turns back on the ones still wanted, in After a restore, on Home.',
    );
    expect(words).toContain(
      '1 request to send documents is paused, so one taken back since the backup does not work again. An owner turns back on the ones still wanted, in After a restore, on Home.',
    );
    expect(words).toContain(
      'An owner turns each back on, one tap each, in After a restore, on Home.',
    );
    expect(words).not.toContain('Settings → After a restore');
  });
});
