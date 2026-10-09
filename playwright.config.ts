import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real containers: `docker compose up -d`
 * first, then `pnpm e2e`. FDV_E2E_URL points elsewhere if needed.
 */
export default defineConfig({
  testDir: 'e2e',
  // One vault, one run: the specs share the household first-run makes, so
  // they go one after another, in file order.
  workers: 1,
  fullyParallel: false,
  // first-run.spec.ts makes that household, so it goes first by name, not
  // by where its name happens to sort (collections.spec.ts sorts before it).
  projects: [
    { name: 'first run', testMatch: 'first-run.spec.ts' },
    {
      name: 'on its vault',
      testIgnore: ['first-run.spec.ts', 'desktop.spec.ts'],
      dependencies: ['first run'],
    },
    // The wide layouts (Phase 6, R5): a few specs at 1280 × 800, on the same
    // vault, run whatever the phone's came to.
    {
      name: 'desktop',
      testMatch: 'desktop.spec.ts',
      dependencies: ['first run'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.FDV_E2E_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
  },
});
