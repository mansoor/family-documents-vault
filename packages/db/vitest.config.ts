import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db',
    include: ['src/**/*.test.ts'],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
  },
});
