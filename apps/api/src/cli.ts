import { readFile } from 'node:fs/promises';
import { EnvKeyProvider, rotateMasterKey } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { loadConfig } from './config.js';

/**
 * Operator commands, run inside the api container:
 *
 *   node apps/api/dist/cli.mjs rotate-master-key
 *
 * Reads the current key from the normal configuration and the new one from
 * FDV_MASTER_KEY_NEW. Rewraps every scope key in one transaction; file
 * content is untouched. Afterwards, put the new key in .env and restart —
 * every session is signed out, because session signing derives from it.
 */
async function main() {
  const command = process.argv[2];
  if (command !== 'rotate-master-key') {
    console.error('usage: cli.mjs rotate-master-key   (with FDV_MASTER_KEY_NEW set)');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const current = config.FDV_MASTER_KEY_FILE
    ? (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim()
    : (config.FDV_MASTER_KEY as string);
  const next = process.env.FDV_MASTER_KEY_NEW;
  if (!next || next.length < 32) {
    console.error('FDV_MASTER_KEY_NEW must be set and at least 32 characters');
    process.exitCode = 2;
    return;
  }
  const admin = createPool(config.DATABASE_ADMIN_URL ?? config.DATABASE_URL, 1);
  try {
    const { rewrapped } = await rotateMasterKey(
      admin,
      new EnvKeyProvider(current),
      new EnvKeyProvider(next),
    );
    console.log(
      `rewrapped ${rewrapped} scope key(s). Now set FDV_MASTER_KEY to the new value and restart.`,
    );
  } finally {
    await admin.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
