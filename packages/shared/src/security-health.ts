import { offsiteProblemWords, type OffsiteProblem } from './backup-offsite.js';

/**
 * System health (0.9.0; Security & health until 24 Nov 2026): an owner's card, read from what the vault
 * already keeps — its activity log and its off-site copy's setting. Nothing
 * new is collected about anybody: the worker writes one line to the log
 * when it makes a backup (or one fails), when it checks the activity log,
 * and when the restore drill is run; failed sign-ins and a sign-in used
 * from two places were already lines of it.
 *
 * Each line is fine, a gentle note (a restore drill to run), or a problem
 * said in plain words with where to fix it. The owners are emailed once
 * when the backups stop or the check fails, and not again until it clears.
 *
 * The server's lines — its backups, their copy off-site, the restore drill
 * — are the installation's own household's (the first one set up); on the
 * hosted edition, whose operator keeps the backups, nobody's.
 */

/** The log's lines the worker writes for the card: about the vault, never about anybody. */
export const HEALTH_EVENTS = {
  /** A backup made: its size. */
  backupMade: 'vault.backup_made',
  /** A backup that did not finish, after its last try. */
  backupFailed: 'vault.backup_failed',
  /** The activity log checked: `ok`, and where it broke when not. */
  auditChecked: 'vault.audit_checked',
  /** The restore drill run (`cli.mjs restore-drill`): `ok`. */
  restoreDrilled: 'vault.restore_drilled',
  /** The owners emailed about a problem (`about`): once until it clears. */
  ownersTold: 'vault.owners_told',
} as const;

/** What the owners are emailed about, once until it clears. */
export type HealthAlertAbout = 'backup' | 'audit_chain';

/** A restore drill older than this is due again: the README asks for one a month. */
export const DRILL_DUE_DAYS = 31;
/** Failed sign-ins in a day before the card says so as a problem: a few are mistyped passwords. */
export const SIGN_IN_FAILURES_MANY = 5;
/** The activity log is checked every night: older than this, the worker has stopped. */
export const AUDIT_CHECK_LATE_DAYS = 2;
/** A backup older than this is late, unless FDV_BACKUP_LATE_DAYS says otherwise: nightly backups. */
export const BACKUP_LATE_DAYS = 2;

export interface SecurityHealthView {
  /**
   * Whoever runs the vault keeps its server (the hosted edition): the
   * card says to contact them, never to restore a backup or run a command.
   */
  hosted: boolean;
  /**
   * The nightly backup: when the last one was made. Null on the hosted
   * edition, and for a household other than the installation's own.
   * `not_yet`: none yet, on a vault too new for one to be due.
   */
  backup: { state: 'fine' | 'late' | 'failed' | 'not_yet'; last_at: string | null } | null;
  /** Its copy off-site, as Settings → Backups set it up; null when it is not set up. */
  offsite: {
    state: 'fine' | 'late' | 'failed' | 'off';
    last_at: string | null;
    problem: OffsiteProblem | null;
  } | null;
  /** The last restore drill, run on the server. Null where the backup line is. */
  restore_drill: { state: 'fine' | 'due' | 'failed' | 'never'; last_at: string | null } | null;
  /** The nightly check of the activity log. `not_yet`: never checked, which says nothing wrong. */
  audit_chain: { state: 'fine' | 'broken' | 'late' | 'not_yet'; last_at: string | null };
  /** Failed sign-ins to the household's accounts in the last 24 hours. */
  failed_sign_ins: { state: 'fine' | 'many'; count: number };
  /** Sign-ins used from two places in the last 24 hours, which the vault signed out. */
  token_reuse: { state: 'fine' | 'seen'; count: number };
}

/** How a line reads: fine; a gentle note, worth doing; or a problem to fix. */
export type HealthTone = 'fine' | 'note' | 'problem';

/** One line of the card, in words. */
export interface HealthLine {
  key: 'backup' | 'offsite' | 'restore_drill' | 'audit_chain' | 'failed_sign_ins' | 'token_reuse';
  label: string;
  tone: HealthTone;
  words: string;
  /** What to do, for a note or a problem. */
  fix: string | null;
  /** The page in the app that helps, if there is one. */
  to: string | null;
}

const WORKER_RUNNING =
  'Check that the vault’s worker is running: on the server, run docker compose ps.';
const DRILL = 'On the server, run: docker compose exec worker sh scripts/restore-drill.sh';
const OPERATOR = 'Contact whoever runs your vault.';

/**
 * The card's lines, in order. `when` says a time as the app does, on the
 * family's clock ("12 Oct, 14:03").
 */
export function securityHealthLines(
  v: SecurityHealthView,
  when: (iso: string) => string,
): HealthLine[] {
  const lines: HealthLine[] = [];
  const at = (iso: string | null) => (iso ? when(iso) : null);
  if (v.backup) {
    const last = at(v.backup.last_at);
    const b = v.backup;
    lines.push(
      b.state === 'fine'
        ? line('backup', 'Backups', 'fine', `The last backup was made on ${last}.`)
        : b.state === 'not_yet'
          ? line('backup', 'Backups', 'fine', 'The first backup is made tonight.')
          : b.state === 'failed'
            ? line(
                'backup',
                'Backups',
                'problem',
                last
                  ? `The last backup didn’t finish. The one before was made on ${last}.`
                  : 'The last backup didn’t finish, and none has been made yet.',
                `${WORKER_RUNNING} Its log says why: docker compose logs worker.`,
              )
            : line(
                'backup',
                'Backups',
                'problem',
                last ? `No backup has been made since ${last}.` : 'No backup has been made yet.',
                WORKER_RUNNING,
              ),
    );
  }
  if (v.offsite) {
    const o = v.offsite;
    const last = at(o.last_at);
    lines.push(
      o.state === 'fine'
        ? line(
            'offsite',
            'Copy off-site',
            'fine',
            last
              ? `The last copy went on ${last}.`
              : 'On. The first copy goes after the next backup.',
          )
        : o.state === 'off'
          ? line('offsite', 'Copy off-site', 'fine', 'Set up, and turned off.')
          : o.state === 'failed'
            ? line(
                'offsite',
                'Copy off-site',
                'problem',
                `The last copy didn’t go. ${offsiteProblemWords(o.problem)}`,
                'Open Settings → Backups, send a test, and fix what it says.',
                '/settings/backups',
              )
            : line(
                'offsite',
                'Copy off-site',
                'problem',
                last ? `No copy has gone since ${last}.` : 'No copy has gone yet.',
                'Open Settings → Backups and send a test. If it goes, check that backups are made.',
                '/settings/backups',
              ),
    );
  }
  if (v.restore_drill) {
    const d = v.restore_drill;
    const last = at(d.last_at);
    lines.push(
      d.state === 'fine'
        ? line('restore_drill', 'Restore drill', 'fine', `The last drill, on ${last}, worked.`)
        : d.state === 'failed'
          ? line(
              'restore_drill',
              'Restore drill',
              'problem',
              `The last drill, on ${last}, failed: a backup may not restore.`,
              `Run it again and read what it says. ${DRILL}`,
            )
          : line(
              'restore_drill',
              'Restore drill',
              'note',
              d.state === 'due'
                ? `The last drill was on ${last}. Worth running one each month.`
                : 'No restore drill yet. It shows a backup really restores.',
              DRILL,
            ),
    );
  }
  const c = v.audit_chain;
  const checked = at(c.last_at);
  lines.push(
    c.state === 'fine'
      ? line(
          'audit_chain',
          'Activity log check',
          'fine',
          `Checked on ${checked}: nothing changed or missing.`,
        )
      : c.state === 'not_yet'
        ? line(
            'audit_chain',
            'Activity log check',
            'fine',
            'Not checked yet: it is checked each night.',
          )
        : c.state === 'broken'
          ? line(
              'audit_chain',
              'Activity log check',
              'problem',
              `The check on ${checked} found a line of the activity log changed or missing.`,
              v.hosted
                ? OPERATOR
                : 'Someone may have changed the database directly. Restore a backup from before then, or ask whoever helps you run the vault.',
            )
          : line(
              'audit_chain',
              'Activity log check',
              'problem',
              `Not checked since ${checked}.`,
              v.hosted ? OPERATOR : WORKER_RUNNING,
            ),
  );
  const f = v.failed_sign_ins;
  lines.push(
    f.count === 0
      ? line('failed_sign_ins', 'Failed sign-ins', 'fine', 'None in the last day.')
      : f.state === 'fine'
        ? line(
            'failed_sign_ins',
            'Failed sign-ins',
            'fine',
            `${count(f.count, 'failed sign-in')} in the last day: a mistyped password, most likely.`,
          )
        : line(
            'failed_sign_ins',
            'Failed sign-ins',
            'problem',
            `${count(f.count, 'failed sign-in')} in the last day.`,
            'Activity says whose account. If it wasn’t them, change their password and turn on two-step sign-in.',
            '/activity',
          ),
  );
  const r = v.token_reuse;
  lines.push(
    r.count === 0
      ? line('token_reuse', 'Sign-ins used twice', 'fine', 'None in the last day.')
      : line(
          'token_reuse',
          'Sign-ins used twice',
          'problem',
          r.count === 1
            ? 'A sign-in was used from two places in the last day, so the vault signed it out.'
            : `${r.count} sign-ins were used from two places in the last day, so the vault signed them out.`,
          'If nobody restored a phone or browser from a backup, change that person’s password. Activity says whose.',
          '/activity',
        ),
  );
  return lines;
}

function line(
  key: HealthLine['key'],
  label: string,
  tone: HealthTone,
  words: string,
  fix: string | null = null,
  to: string | null = null,
): HealthLine {
  return { key, label, tone, words, fix, to };
}

const count = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);
