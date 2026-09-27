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
  },
});
