import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    // Closing a harness (its pools, its queue) takes a few seconds, and
    // longer when the machine is busy: 10 s timed four files out (5.3).
    hookTimeout: 30_000,
    // A test that talks to the database for a few round trips took longer
    // than the default 5 s when other test runs shared it (5.17), as the
    // web's did (5.16). A ceiling only: a passing test is no slower.
    testTimeout: 15_000,
  },
});
