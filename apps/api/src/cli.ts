import { readFile } from 'node:fs/promises';
import { EnvKeyProvider, rotateMasterKey, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool } from '@fdv/db';
import { PasswordService, RESET_TTL_MINUTES } from './auth/passwords.js';
import { loadConfig } from './config.js';

/**
 * Operator commands, run inside the api container:
 *
 *   node apps/api/dist/cli.mjs rotate-master-key
 *   node apps/api/dist/cli.mjs reset-password someone@example.com
 *
 * `rotate-master-key` reads the current key from the normal configuration
 * and the new one from FDV_MASTER_KEY_NEW. It rewraps every scope key in
 * one transaction; file content is untouched. Afterwards, put the new key
 * in .env and restart — every session is signed out, because session
 * signing derives from it.
 *
 * `reset-password` prints a one-time link for an account that cannot get
 * in any other way. It exists because a household with no mail server
 * would otherwise have no route at all, and it is restricted to the
 * command line on purpose: an owner who could reset another adult's
 * password could sign in as them and read their private documents.
 * Whoever can run this already holds the master key.
 */
async function main() {
  const command = process.argv[2];
  if (command === 'reset-password') return resetPassword(process.argv[3]);
  if (command !== 'rotate-master-key') {
    console.error(
      'usage: cli.mjs rotate-master-key   (with FDV_MASTER_KEY_NEW set)\n' +
        '       cli.mjs reset-password <email>',
    );
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

async function resetPassword(email: string | undefined) {
  if (!email) {
    console.error('usage: cli.mjs reset-password <email>');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const master = config.FDV_MASTER_KEY_FILE
    ? (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim()
    : (config.FDV_MASTER_KEY as string);
  const pool = createPool(config.DATABASE_URL, 1);
  const db = createDb(pool);
  try {
    const account = await db
      .selectFrom('account')
      .select(['id', 'email'])
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst();
    if (!account) {
      // The command line is not an enumeration surface — whoever is here
      // can read the table — so this one says what happened.
      console.error(`No sign-in here uses ${email}.`);
      process.exitCode = 1;
      return;
    }
    const passwords = new PasswordService(
      db,
      new ScopeKeys(new EnvKeyProvider(master)),
      null,
      config.FDV_BASE_URL,
    );
    const reset = await passwords.issue(account.id, 'operator');
    console.log(
      `A one-time link for ${account.email}, good for ${RESET_TTL_MINUTES} minutes:\n\n` +
        `  ${passwords.linkFor(reset.token)}\n\n` +
        'Hand it to them directly. It signs every one of their devices out when it is used.',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
