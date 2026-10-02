import { stat } from 'node:fs/promises';
import { adapterFromRow, StorageError, type StorageAdapter, type VaultRowLike } from '@fdv/storage';
import type pg from 'pg';

/**
 * Files a restore finds gone (5.24).
 *
 * A backup holds only the database. Restoring one made before a document
 * was removed for good brings back its record without its file: the restore
 * looks for every version's file and marks each one that is not there
 * (`document_version.file_removed_at`), so its document says "The file was
 * removed for good" rather than failing.
 *
 * Only where the files are kept clearly holds files. A folder that is not
 * there, or a place where not one of the files it should hold is found — a
 * volume not mounted yet, the files not copied back yet, a mistyped
 * FDV_LOCAL_VAULT_DIR, a new bucket — says nothing about any one document:
 * its versions are counted as not looked for, with the reason, and nothing
 * is marked (the 5.24 review, D524-02).
 *
 * And a mark is not for ever: `recheckRemovedFiles` (the worker's
 * `recheck-files`) looks again at every marked version and unmarks each one
 * whose file is back. Removing a document for good looks too, first.
 */

/** Where the files are kept: the key that opens a vault's bucket credentials, and the local folder. */
export interface FileStorage {
  credentialsKey: Buffer;
  localRoot: string;
}

export type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

interface Version {
  id: string;
  household_id: string;
  document_id: string;
  storage_key: string;
  vault_id: string;
}

/** What looking for some versions' files found. */
interface Looked {
  present: Version[];
  missing: Version[];
  unchecked: Version[];
  /** Why some could not be looked for, a sentence a place. */
  why: string[];
}

const exists = (dir: string) =>
  stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * Each version's file, looked for in the place its vault keeps files. A
 * place that cannot be opened or reached, a local folder that is not there,
 * or one in which not one of these files is found, gives "not looked for".
 * With `allMissingIsUnchecked` false — looking again at marked versions —
 * only the files found count.
 */
async function lookFor(
  admin: pg.Pool,
  storage: FileStorage,
  versions: Version[],
  allMissingIsUnchecked: boolean,
): Promise<Looked> {
  const looked: Looked = { present: [], missing: [], unchecked: [], why: [] };
  if (versions.length === 0) return looked;
  const { rows: vaults } = await admin.query<VaultRowLike>(
    'select id, kind, label, endpoint, bucket, region, path_style, credentials_encrypted from vault',
  );
  const byVault = new Map<string, Version[]>();
  for (const v of versions) byVault.set(v.vault_id, [...(byVault.get(v.vault_id) ?? []), v]);
  for (const [vaultId, held] of byVault) {
    const row = vaults.find((v) => v.id === vaultId);
    const name = row ? `“${row.label}”` : 'a place no longer set up';
    const notLooked = (why: string) => {
      looked.unchecked.push(...held);
      looked.why.push(why);
    };
    if (!row) {
      notLooked(`${held.length} file(s) are in a place that is no longer set up.`);
      continue;
    }
    if (row.kind === 'local' && !(await exists(storage.localRoot))) {
      notLooked(
        `The folder ${storage.localRoot}, where ${name} keeps its files, is not there: is it mounted?`,
      );
      continue;
    }
    let adapter: StorageAdapter;
    try {
      adapter = adapterFromRow(row, storage.credentialsKey, storage.localRoot);
    } catch (err) {
      notLooked(`${name} could not be opened: ${(err as Error).message}`);
      continue;
    }
    const present: Version[] = [];
    const missing: Version[] = [];
    let unreached = 0;
    for (const v of held) {
      try {
        await adapter.stat(v.storage_key);
        present.push(v);
      } catch (err) {
        if (err instanceof StorageError && err.code === 'not_found') missing.push(v);
        else {
          looked.unchecked.push(v);
          unreached += 1;
        }
      }
    }
    if (unreached) looked.why.push(`${unreached} file(s) in ${name} could not be reached.`);
    if (allMissingIsUnchecked && present.length === 0 && missing.length > 0) {
      // Not one of them there: the place looks empty, not each file removed.
      looked.unchecked.push(...missing);
      looked.why.push(
        `None of the ${missing.length} file(s) ${name} should hold is there: are the files ` +
          'copied back, and the folder or bucket the right one? Nothing was marked removed; ' +
          'put them back and the documents open as before.',
      );
      continue;
    }
    looked.present.push(...present);
    looked.missing.push(...missing);
  }
  return looked;
}

/** What a restore's look for the files found. */
export interface RemovedFiles {
  /** Versions whose file is gone: removed for good after the backup was made. Each is marked. */
  filesRemoved: Array<{ household_id: string; document_id: string; version_id: string }>;
  /** Versions whose file could not be looked for, and so are not marked. */
  filesUnchecked: number;
  /** Why, a sentence a place. */
  filesUncheckedWhy: string[];
}

/**
 * Looks for every unmarked version's file, as the owner, past the
 * households' walls, as the rest of a restore's own work is; marks the ones
 * clearly gone.
 */
export async function markRemovedFiles(
  admin: pg.Pool,
  storage: FileStorage,
  log: Log,
): Promise<RemovedFiles> {
  const { rows } = await admin.query<Version>(
    `select id, household_id, document_id, storage_key, vault_id
       from document_version
      where file_removed_at is null
      order by household_id, document_id, version_no`,
  );
  const looked = await lookFor(admin, storage, rows, true);
  if (looked.missing.length) {
    await admin.query(
      'update document_version set file_removed_at = now() where id = any($1::uuid[])',
      [looked.missing.map((v) => v.id)],
    );
    log('info', 'files removed for good since the backup was made', {
      versions: looked.missing.length,
      documents: new Set(looked.missing.map((v) => v.document_id)).size,
    });
  }
  if (looked.unchecked.length) {
    log('warn', 'files that could not be looked for', {
      versions: looked.unchecked.length,
      why: looked.why,
    });
  }
  return {
    filesRemoved: looked.missing.map((v) => ({
      household_id: v.household_id,
      document_id: v.document_id,
      version_id: v.id,
    })),
    filesUnchecked: looked.unchecked.length,
    filesUncheckedWhy: looked.why,
  };
}

/** What looking again at the marked versions found. */
export interface Rechecked {
  /** Marked removed, and found after all: unmarked. */
  found: number;
  /** Still not there. */
  stillRemoved: number;
  unchecked: number;
  uncheckedWhy: string[];
}

/**
 * Looks again at every version marked removed for good, and unmarks each
 * whose file is where it is kept after all — put back after a restore that
 * ran too early, say. `recheck-files`, any time.
 */
export async function recheckRemovedFiles(
  admin: pg.Pool,
  storage: FileStorage,
  log: Log,
): Promise<Rechecked> {
  const { rows } = await admin.query<Version>(
    `select id, household_id, document_id, storage_key, vault_id
       from document_version
      where file_removed_at is not null
      order by household_id, document_id, version_no`,
  );
  const looked = await lookFor(admin, storage, rows, false);
  if (looked.present.length) {
    await admin.query(
      'update document_version set file_removed_at = null where id = any($1::uuid[])',
      [looked.present.map((v) => v.id)],
    );
    log('info', 'files found again, no longer marked removed', {
      versions: looked.present.length,
    });
  }
  return {
    found: looked.present.length,
    stillRemoved: looked.missing.length,
    unchecked: looked.unchecked.length,
    uncheckedWhy: looked.why,
  };
}
