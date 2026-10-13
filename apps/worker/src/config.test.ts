import { describe, expect, it } from 'vitest';
import { loadConfig, LOG_LEVELS, logs } from './config.js';

/**
 * LOG_LEVEL as the README offers it (the Phase 5 exit's review, D541-06):
 * compose passes the one setting to the API and the worker alike, and the
 * worker refused `trace` and `fatal`, which the API takes, and stopped.
 */
describe("the worker's LOG_LEVEL", () => {
  const env = { DATABASE_URL: 'postgres://localhost/fdv', FDV_MASTER_KEY: 'k'.repeat(43) };

  it('takes every level the API takes', () => {
    expect(LOG_LEVELS).toEqual(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
    for (const level of LOG_LEVELS) {
      expect(loadConfig({ ...env, LOG_LEVEL: level }).LOG_LEVEL, level).toBe(level);
    }
    expect(loadConfig(env).LOG_LEVEL).toBe('info');
    expect(() => loadConfig({ ...env, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('writes a line at its level and above, and nothing below it', () => {
    expect(['error', 'warn', 'info'].map((l) => logs('info', l))).toEqual([true, true, true]);
    expect(logs('info', 'debug')).toBe(false);
    expect(logs('warn', 'info')).toBe(false);
    expect(logs('fatal', 'error')).toBe(false);
    expect(['fatal', 'error', 'warn', 'info', 'debug'].every((l) => logs('trace', l))).toBe(true);
    // A level nobody knows is never written.
    expect(logs('trace', 'loud')).toBe(false);
  });
});

/**
 * Email in's settings (S4): TLS on 993 by default, INBOX, every five
 * minutes, moved to Filed; what is wrong refused by name — and the
 * password never in what is said of a setting that is wrong.
 */
describe("the worker's email in settings", () => {
  const env = { DATABASE_URL: 'postgres://localhost/fdv', FDV_MASTER_KEY: 'k'.repeat(43) };

  it('has the defaults the README gives, and refuses what cannot be', () => {
    expect(loadConfig(env)).toMatchObject({
      FDV_MAIL_IN_PORT: 993,
      FDV_MAIL_IN_FOLDER: 'INBOX',
      FDV_MAIL_IN_POLL_SECONDS: 300,
      FDV_MAIL_IN_AFTER: 'move',
    });
    expect(loadConfig(env).FDV_MAIL_IN_HOST).toBeUndefined();
    expect(() => loadConfig({ ...env, FDV_MAIL_IN_AFTER: 'archive' })).toThrow(/FDV_MAIL_IN_AFTER/);
    expect(() => loadConfig({ ...env, FDV_MAIL_IN_POLL_SECONDS: '5' })).toThrow(
      /FDV_MAIL_IN_POLL_SECONDS/,
    );
    expect(() => loadConfig({ ...env, FDV_MAIL_IN_HOST: 'imap.example.com/evil' })).toThrow(
      /FDV_MAIL_IN_HOST/,
    );
    expect(() => loadConfig({ ...env, FDV_MAIL_IN_AUTHSERV_ID: 'mx google' })).toThrow(
      /FDV_MAIL_IN_AUTHSERV_ID/,
    );
  });

  it('never says the password when something else is wrong', () => {
    const password = 'p4ss-never-said-anywhere';
    let said = '';
    try {
      loadConfig({ ...env, FDV_MAIL_IN_PASSWORD: password, FDV_MAIL_IN_PORT: 'imap' });
    } catch (err) {
      said = (err as Error).message;
    }
    expect(said).toMatch(/FDV_MAIL_IN_PORT/);
    expect(said).not.toContain(password);
  });
});
