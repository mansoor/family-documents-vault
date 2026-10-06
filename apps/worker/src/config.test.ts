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
