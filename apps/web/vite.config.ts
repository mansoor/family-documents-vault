import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    // The browser's clock in a test is UTC, as a fresh vault's family clock
    // is (0.9.0, TZ): the same answers on every machine. A test of the
    // family's clock against another browser zone sets its own
    // (FamilyTime.test.tsx).
    env: { TZ: 'UTC' },
    // A findBy may wait 3 s (test-setup.ts), so a scenario with several took
    // longer than the default 5 s while the whole gate ran at once (5.16).
    testTimeout: 15_000,
  },
});
