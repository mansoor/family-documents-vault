import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    // Closing a harness (its pools, its queue) takes a few seconds, and
    // longer when the machine is busy: 10 s timed four files out (5.3).
    hookTimeout: 30_000,
  },
});
