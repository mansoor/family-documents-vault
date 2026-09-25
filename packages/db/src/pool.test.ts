import { describe, expect, it, vi } from 'vitest';
import { createPool } from './client.js';

describe('a pool', () => {
  it('an idle connection the server ends is said, not an uncaught exception', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pool = createPool('postgres://nobody@127.0.0.1:1/none', 1);
      const ended = Object.assign(
        new Error('terminating connection due to administrator command'),
        {
          code: '57P01',
        },
      );
      // What node-postgres does when a server ends an idle connection: an
      // 'error' on the pool, which throws if nobody listens.
      expect(() => pool.emit('error', ended)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminating connection'));
      await pool.end();
    } finally {
      warn.mockRestore();
    }
  });
});
