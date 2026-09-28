import {
  CannotSeeVault,
  MASTER_SEALED,
  MasterKeyMismatch,
  movedCount,
  repairMasterKey,
  rotateMasterKey,
  type RekeyReport,
  type SealedName,
} from '@fdv/crypto';
import { createPool } from '@fdv/db';

/**
 * `cli.mjs rotate-master-key`: the vault's database, moved onto the key in
 * FDV_MASTER_KEY_NEW (see rotateMasterKey). `cli.mjs repair-master-key`: a
 * vault left partly under FDV_MASTER_KEY_PREVIOUS, moved wholly onto
 * FDV_MASTER_KEY (see repairMasterKey). What they print is counts and row
 * ids, never a key or a secret.
 *
 * Exit codes: 0 done (or nothing to do), 1 something does not open with
 * the keys given, 2 refused before anything was changed.
 */

/**
 * What a new master key must be: at least 32 characters, of the kind the
 * README's command makes (base64url) or base64 or hex. Nothing a copy and
 * paste adds (a space, a line break), and nothing `.env` or Docker Compose
 * would change on the way back in (quotes, `#`, `$`): the key written into
 * `.env` afterwards must be the very key the database was moved onto.
 */
const KEY_SHAPE = /^[A-Za-z0-9_+/=.-]+$/;

/** Why FDV_MASTER_KEY_NEW will not do, or null if it will. */
export function newMasterKeyProblem(current: string, next: string | undefined): string | null {
  if (!next) return 'FDV_MASTER_KEY_NEW must be set to the new key.';
  if (!KEY_SHAPE.test(next)) {
    return (
      'FDV_MASTER_KEY_NEW may hold only letters, digits and - _ + / = . — no spaces, line ' +
      'breaks, quotes, # or $. Make one with the command in the README.'
    );
  }
  if (next.length < 32) return 'FDV_MASTER_KEY_NEW must be at least 32 characters.';
  if (next === current) {
    return 'FDV_MASTER_KEY_NEW is the key the vault already uses. Make a new one.';
  }
  return null;
}

const SEALED_LABEL: Record<SealedName, [one: string, many: string]> = {
  totpSecrets: ['two-step sign-in secret', 'two-step sign-in secrets'],
  vaultCredentials: ['storage (S3) credential', 'storage (S3) credentials'],
  smtpPasswords: ['mail (SMTP) password', 'mail (SMTP) passwords'],
};

export interface CommandOptions {
  /** The key the vault runs with now: FDV_MASTER_KEY, or FDV_MASTER_KEY_FILE's. */
  current: string;
  /** DATABASE_ADMIN_URL: the owning role, which sees every household. Required. */
  adminUrl: string | undefined;
  /** --even-if-connected: go ahead although something is connected to the database. */
  evenIfConnected?: boolean | undefined;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Runs `rotate-master-key`; resolves to its exit code. */
export async function rotateMasterKeyCommand(
  o: CommandOptions & { /** FDV_MASTER_KEY_NEW. */ next: string | undefined },
): Promise<number> {
  const io = streams(o);
  const problem = newMasterKeyProblem(o.current, o.next);
  if (problem !== null || o.next === undefined) {
    io.err(`${problem ?? 'FDV_MASTER_KEY_NEW must be set.'} Nothing was changed.`);
    return 2;
  }
  const next = o.next;
  return guarded(o, 'rotate', async (admin) => {
    let moved;
    try {
      moved = await rotateMasterKey(admin, o.current, next);
    } catch (e) {
      if (!(e instanceof MasterKeyMismatch)) throw e;
      io.err('Nothing was changed. These open with neither FDV_MASTER_KEY nor FDV_MASTER_KEY_NEW:');
      unopened(e, io.err);
      io.err(
        e.opened > 0
          ? 'The rest opens. If the master key was rotated by a release before 0.5.0, part of the ' +
              'vault is still under the key before: repair it first with repair-master-key (see ' +
              '"Rotating the master key" in the README).'
          : 'FDV_MASTER_KEY is read from .env (or FDV_MASTER_KEY_FILE): is it the key this vault ' +
              'runs with?',
      );
      return 1;
    }
    if (moved.alreadyDone) {
      io.out('The database is already on the new key: an earlier run finished.');
      io.out('Put FDV_MASTER_KEY_NEW in .env as FDV_MASTER_KEY (or in your FDV_MASTER_KEY_FILE)');
      io.out('and run: docker compose up -d');
      return 0;
    }
    io.out('The database is on the new master key. In one transaction:');
    counts(moved, io.out);
    if (moved.unchanged > 0) {
      io.out(`  ${n(moved.unchanged, 'key or secret was', 'keys or secrets were')} on it already`);
    }
    io.out(`  ${n(moved.sessionsEnded, 'session', 'sessions')} ended: everybody signs in again`);
    io.out('');
    io.out('Now put the new key in .env as FDV_MASTER_KEY (or in your FDV_MASTER_KEY_FILE) and');
    io.out('start the vault: docker compose up -d (not start or restart, which keep the old key).');
    io.out('Keep the old key with your backups: one made before now is restored with it, as');
    io.out('FDV_MASTER_KEY_PREVIOUS. The README says how.');
    return 0;
  });
}

/** Runs `repair-master-key`; resolves to its exit code. */
export async function repairMasterKeyCommand(
  o: CommandOptions & { /** FDV_MASTER_KEY_PREVIOUS. */ previous: string | undefined },
): Promise<number> {
  const io = streams(o);
  const previous = o.previous;
  if (!previous || previous.length < 32 || previous === o.current) {
    io.err(
      (!previous
        ? 'FDV_MASTER_KEY_PREVIOUS must be set to the key the vault was on before its last rotation.'
        : previous === o.current
          ? 'FDV_MASTER_KEY_PREVIOUS is the key the vault runs with: give the one before it.'
          : 'FDV_MASTER_KEY_PREVIOUS must be at least 32 characters.') + ' Nothing was changed.',
    );
    return 2;
  }
  return guarded(o, 'repair', async (admin) => {
    let moved;
    try {
      moved = await repairMasterKey(admin, o.current, previous);
    } catch (e) {
      if (!(e instanceof MasterKeyMismatch)) throw e;
      io.err(
        'Nothing was changed. These open with neither FDV_MASTER_KEY nor FDV_MASTER_KEY_PREVIOUS:',
      );
      unopened(e, io.err);
      return 1;
    }
    if (movedCount(moved) === 0) {
      io.out('Everything already opens with FDV_MASTER_KEY: there is nothing to repair.');
      return 0;
    }
    io.out('The vault is wholly on FDV_MASTER_KEY again. In one transaction:');
    counts(moved, io.out);
    io.out(`  ${n(moved.sessionsEnded, 'session', 'sessions')} ended: everybody signs in again`);
    io.out('');
    io.out('Start the vault: docker compose up -d');
    return 0;
  });
}

function streams(o: CommandOptions) {
  return {
    out: o.out ?? ((line: string) => console.log(line)),
    err: o.err ?? ((line: string) => console.error(line)),
  };
}

function counts(moved: RekeyReport, out: (line: string) => void): void {
  out(`  ${n(moved.rewrapped, 'scope key', 'scope keys')} rewrapped`);
  for (const s of MASTER_SEALED) {
    const [one, many] = SEALED_LABEL[s.name];
    out(`  ${n(moved.resealed[s.name], one, many)} sealed again`);
  }
}

function unopened(e: MasterKeyMismatch, err: (line: string) => void): void {
  for (const what of e.unopened.slice(0, 20)) err(`  ${what}`);
  if (e.unopened.length > 20) err(`  and ${e.unopened.length - 20} more`);
}

/**
 * What both commands refuse before they change anything: no owning role,
 * the vault still connected, a connection that cannot see every household.
 */
async function guarded(
  o: CommandOptions,
  verb: 'rotate' | 'repair',
  run: (admin: ReturnType<typeof createPool>) => Promise<number>,
): Promise<number> {
  const io = streams(o);
  if (!o.adminUrl) {
    io.err(
      `DATABASE_ADMIN_URL is needed to ${verb} the master key: it is the owning role, which ` +
        'sees every household. docker-compose.yml sets it. Nothing was changed.',
    );
    return 2;
  }
  const admin = createPool(o.adminUrl, 1);
  try {
    if (!o.evenIfConnected) {
      const connected = await otherConnections(admin);
      if (connected > 0) {
        io.err(
          `The vault is still running (${n(connected, 'other connection', 'other connections')} ` +
            'to its database): docker compose stop api worker, then run this again. Nothing ' +
            'was changed. (If what is connected is not the vault, add --even-if-connected.)',
        );
        return 2;
      }
    }
    return await run(admin);
  } catch (e) {
    if (e instanceof CannotSeeVault) {
      io.err(`DATABASE_ADMIN_URL cannot be used here: ${e.message}. Nothing was changed.`);
      return 2;
    }
    throw e;
  } finally {
    await admin.end();
  }
}

/** Anything else connected to the vault's database: the api, the worker, a psql. */
async function otherConnections(admin: ReturnType<typeof createPool>): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and backend_type = 'client backend'
        and pid <> pg_backend_pid()`,
  );
  return rows[0]?.n ?? 0;
}
