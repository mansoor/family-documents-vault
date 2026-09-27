import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts'],
    // A hook makes a database from the template and closes it again, which
    // takes longer when the machine is busy: 10 s timed one out (5.15), as
    // it did the API's (5.3).
    hookTimeout: 30_000,
    // As the API's (5.17): database round trips on a shared, busy machine.
    testTimeout: 15_000,
  },
});
