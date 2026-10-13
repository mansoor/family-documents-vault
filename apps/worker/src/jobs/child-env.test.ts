import { afterEach, describe, expect, it } from 'vitest';
import { childEnv, LIBPQ } from './child-env.js';
import { takeMailInPassword } from './mail-in.js';
import { runTool } from './tools.js';

/**
 * What the worker hands the tools it runs (the S4 review, F7): the few
 * names a program needs and its own settings — never the master key, the
 * database's address or the mailbox's password; and the password taken out
 * of the worker's own environment once it is read.
 */

const SECRETS = {
  FDV_MASTER_KEY: 'master-key-never-handed-on',
  FDV_MAIL_IN_PASSWORD: 'mailbox-password-never-handed-on',
  DATABASE_URL: 'postgres://fdv_app:secret@db/fdv',
};

describe('what a tool is handed of the worker’s environment (F7)', () => {
  const was = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in was)) delete process.env[k];
    Object.assign(process.env, was);
  });

  it('the few names a program needs, and its own settings; never a secret', () => {
    const env = childEnv({ MAGICK_TEMPORARY_PATH: '/tmp/x' }, undefined, {
      ...SECRETS,
      PATH: '/usr/bin',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      MAGICK_CONFIGURE_PATH: '/etc/magick',
      TESSDATA_PREFIX: '/usr/share/tessdata',
      PGSSLMODE: 'require',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      MAGICK_CONFIGURE_PATH: '/etc/magick',
      TESSDATA_PREFIX: '/usr/share/tessdata',
      MAGICK_TEMPORARY_PATH: '/tmp/x',
    });
    // The database's tools are given libpq's own settings too, and still no secret but their connection.
    expect(childEnv({ PGPASSWORD: 'theirs' }, LIBPQ, { ...SECRETS, PGSSLMODE: 'require' })).toEqual(
      {
        PGSSLMODE: 'require',
        PGPASSWORD: 'theirs',
      },
    );
  });

  it('a tool run is handed none of the worker’s secrets', async () => {
    Object.assign(process.env, SECRETS);
    const { stdout } = await runTool(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify(process.env))',
    ]);
    for (const value of Object.values(SECRETS)) expect(stdout).not.toContain(value);
    expect(Object.keys(JSON.parse(stdout) as object)).not.toContain('FDV_MASTER_KEY');
  });

  it('the mailbox’s password leaves the environment once it is read', () => {
    const env: NodeJS.ProcessEnv = { ...SECRETS };
    takeMailInPassword(env);
    expect(env.FDV_MAIL_IN_PASSWORD).toBeUndefined();
    expect(env.FDV_MASTER_KEY).toBe(SECRETS.FDV_MASTER_KEY);
  });
});
