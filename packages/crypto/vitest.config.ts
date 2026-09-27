import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'crypto',
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    // scope-keys.test.ts makes a database from the template in a hook; on a
    // busy machine that takes longer than the default 10 s.
    hookTimeout: 30_000,
  },
});
