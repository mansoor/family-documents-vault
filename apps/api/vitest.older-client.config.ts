import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const older = (p: string) => here(`../../.older-client/packages/client/src/${p}`);

/**
 * The client contract with the client an older phone carries (5.2).
 * `scripts/older-client.mjs` extracts packages/client/src as tagged into
 * .older-client/, and this points `@fdv/client` at it for
 * `src/client-contract.test.ts` alone. The server under test is this
 * commit's; `@fdv/shared` is too, for both, since the server needs it —
 * the client's own behaviour on the wire is the older one's.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@fdv\/client\/testing$/, replacement: older('testing/index.ts') },
      { find: /^@fdv\/client$/, replacement: older('index.ts') },
      { find: /^@fdv\/shared$/, replacement: here('../../packages/shared/src/index.ts') },
    ],
  },
  test: {
    name: 'api-older-client',
    root: here('.'),
    include: ['src/client-contract.test.ts'],
    hookTimeout: 30_000,
  },
});
