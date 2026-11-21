import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Each client `scripts/older-client.mjs` extracted: its tag, the phone apps
 * that carry it, and the oldest of them, whose User-Agent is sent.
 */
const runs = JSON.parse(readFileSync(here('../../.older-client/runs.json'), 'utf8')) as {
  ref: string;
  apps: string[];
  app: string | null;
}[];

/**
 * The client contract with the clients phones already released carry (5.2).
 * `scripts/older-client.mjs` extracts packages/client/src as tagged into
 * .older-client/<tag>/, and each project here points `@fdv/client` at one
 * of them for `src/client-contract.test.ts` alone, sending its app's
 * User-Agent (FDV_OLDER_CLIENT_APP). The server under test is this
 * commit's; `@fdv/shared` is too, for both, since the server needs it —
 * the client's own behaviour on the wire is the older one's.
 */
export default defineConfig({
  test: {
    projects: runs.map(({ app, apps, ref }) => {
      const older = (p: string) => here(`../../.older-client/${ref}/packages/client/src/${p}`);
      return {
        resolve: {
          alias: [
            { find: /^@fdv\/client\/testing$/, replacement: older('testing/index.ts') },
            { find: /^@fdv\/client$/, replacement: older('index.ts') },
            {
              find: /^@fdv\/shared$/,
              replacement: here('../../packages/shared/src/index.ts'),
            },
          ],
        },
        test: {
          name: `api-older-client ${apps.length ? `app ${apps.join(', ')}` : ref}`,
          root: here('.'),
          include: ['src/client-contract.test.ts'],
          hookTimeout: 30_000,
          env: { FDV_OLDER_CLIENT: ref, ...(app ? { FDV_OLDER_CLIENT_APP: app } : {}) },
        },
      };
    }),
  },
});
