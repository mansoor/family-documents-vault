import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db',
    include: ['src/**/*.test.ts'],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
    // A hook makes a database from the template; on a busy machine that
    // takes longer than the default 10 s (the API's and worker's too).
    hookTimeout: 30_000,
    // Its migration tests build a database a migration at a time, which
    // took longer than the default 5 s when other test runs shared the
    // server (5.21); the other packages' ceiling. A passing test is no slower.
    testTimeout: 15_000,
  },
});
