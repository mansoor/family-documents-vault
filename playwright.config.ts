import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real containers: `docker compose up -d`
 * first, then `pnpm e2e`. FDV_E2E_URL points elsewhere if needed.
 */
export default defineConfig({
  testDir: 'e2e',
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
