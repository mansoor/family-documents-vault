import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import type { CreatedShare } from './documents/shares.js';
import { createHarness, type Harness } from './test-harness.js';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

/**
 * What a stranger's browser is sent (5.16): the pages a link opens, the
 * API they call, and the public-only site in front of both.
 *
 * The pages are served by nginx and the site by Caddy, neither of which
 * runs here; their files are read and held to what they must say. The
 * end-to-end run (e2e/share-link.spec.ts) sees the pages' headers as a
 * browser does, behind the real nginx.
 */

/** The directives of one nginx `location … { }` block, by its opening line. */
function nginxBlock(conf: string, opening: string): string {
  const start = conf.indexOf(opening);
  expect(start, opening).toBeGreaterThan(-1);
  const end = conf.indexOf('\n    }', start);
  return conf.slice(start, end);
}

/** A header an nginx block adds, `always`, as it adds it. */
function added(block: string, name: string): string | null {
  const m = new RegExp(`add_header ${name} "([^"]*)" always;`, 'i').exec(block);
  return m?.[1] ?? null;
}

/** Caddy's path matching: a pattern is exact, or a prefix when it ends in `*`. */
function caddyMatches(patterns: string[], path: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p));
}

/** A strict policy: nothing from anywhere by default, no inline or evaluated script, no frames. */
function expectStrict(csp: string | null, what: string) {
  expect(csp, what).not.toBeNull();
  const policy = csp as string;
  expect(policy, what).toMatch(/(^|; )default-src 'none'(;|$)/);
  expect(policy, what).toMatch(/(^|; )frame-ancestors 'none'(;|$)/);
  expect(policy, what).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  const script = /script-src ([^;]*)/.exec(policy)?.[1];
  if (script !== undefined) expect(script.trim(), what).toBe("'self'");
}

describe('the pages a link opens', () => {
  it('every public page is sent no referrer, no sniffing, no framing and a strict policy', async () => {
    const conf = await readFile(root('docker/nginx.conf'), 'utf8');
    for (const opening of [
      'location ~ ^/s/?$ {',
      'location ^~ /shared/ {',
      // A request to send documents' page (5.21; the page itself is 5.22's).
      'location ~ ^/drop/?$ {',
    ]) {
      const block = nginxBlock(conf, opening);
      expect(added(block, 'Referrer-Policy'), opening).toBe('no-referrer');
      expect(added(block, 'X-Content-Type-Options'), opening).toBe('nosniff');
      expect(added(block, 'X-Frame-Options'), opening).toBe('DENY');
      expectStrict(added(block, 'Content-Security-Policy'), opening);
      // The page itself, not a route of the app's that might send others.
      expect(block, opening).toContain('try_files /index.html =404;');
    }
  });

  it('the vault behind a TLS site keeps the pages’ own referrer policy', async () => {
    // Caddy sets its Referrer-Policy only where the page has none (`?`):
    // otherwise same-origin would replace the share pages' no-referrer.
    for (const file of ['Caddyfile.internal', 'Caddyfile.public']) {
      const caddy = await readFile(root(`docker/caddy/${file}`), 'utf8');
      expect(caddy, file).toMatch(/^\s*\?Referrer-Policy same-origin$/m);
      expect(caddy, file).not.toMatch(/^\s*Referrer-Policy /m);
    }
  });
});

describe('the public-only site', () => {
  let caddy: string;
  let publicPaths: string[];

  beforeAll(async () => {
    caddy = await readFile(root('docker/caddy/Caddyfile.public-only'), 'utf8');
    // The pages, and (5.30) the API routes they call, which go to the API itself.
    publicPaths = ['@public', '@public_api'].flatMap((name) => {
      const m = new RegExp(`^\\s*${name} path (.+)$`, 'm').exec(caddy);
      return (m?.[1] ?? '').trim().split(/\s+/);
    });
  });

  it('/api/v1/auth/sign-in and /api/v1/documents are 404', () => {
    expect(publicPaths.length).toBeGreaterThan(0);
    for (const hidden of [
      '/api/v1/auth/sign-in',
      '/api/v1/auth/password',
      '/api/v1/auth/refresh',
      '/api/v1/documents',
      '/api/v1/documents/7f1c/share',
      '/api/v1/shares',
      '/api/v1/after-restore',
      '/api/v1/capabilities',
      '/api/v1/setup',
      '/',
      '/sign-in',
      '/welcome',
      '/settings',
      '/healthz',
      '/sharedx',
      '/api/v1/sharedsecret',
    ]) {
      expect(caddyMatches(publicPaths, hidden), hidden).toBe(false);
    }
    // Everything not served is answered 404, and the site sends nothing
    // else anywhere.
    expect(caddy).toMatch(/handle \{\s*respond 404\s*\}/);
    expect(caddy.match(/reverse_proxy /g)).toHaveLength(2);
    expect(caddy).toMatch(/handle @public \{\s*reverse_proxy web:80/);
    expect(caddy).toMatch(/handle @public_api \{\s*reverse_proxy api:3000/);
    // The pages' matcher names no API route, and the API's nothing else.
    const pages = /^\s*@public path (.+)$/m.exec(caddy)?.[1] ?? '';
    expect(pages).not.toMatch(/\/api\//);
    const api = (/^\s*@public_api path (.+)$/m.exec(caddy)?.[1] ?? '').trim().split(/\s+/);
    expect(api.sort()).toEqual(['/api/v1/drop/*', '/api/v1/shared/*']);
  });

  it('serves the pages a link opens, what they load, and what they call', () => {
    for (const shown of [
      '/s',
      '/s/',
      '/shared/abcdef0123456789',
      '/assets/index-abc123.js',
      '/assets/index-abc123.css',
      '/api/v1/shared/preview',
      '/api/v1/shared/unlock',
      '/api/v1/shared/items',
      '/api/v1/shared/items/7f1c/content',
      '/api/v1/shared/abcdef0123456789/open',
      '/drop',
      '/drop/',
      '/api/v1/drop/preview',
      '/api/v1/drop/code',
      '/api/v1/drop/unlock',
      '/api/v1/drop/session',
      '/api/v1/drop/files',
      '/api/v1/drop/files/7f1c',
      '/api/v1/drop/finish',
    ]) {
      expect(caddyMatches(publicPaths, shown), shown).toBe(true);
    }
    // And the family's side of a request is not there (5.21).
    for (const hidden of ['/api/v1/upload-requests', '/api/v1/upload-requests/7f1c/resume']) {
      expect(caddyMatches(publicPaths, hidden), hidden).toBe(false);
    }
  });

  it("keeps a sender's calls small, but for a file, and gives a file time to arrive (5.21)", () => {
    const m = /@drop_api path (.+)$/m.exec(caddy);
    const small = (m?.[1] ?? '').trim().split(/\s+/);
    expect(small.sort()).toEqual(
      ['preview', 'code', 'unlock', 'session', 'finish'].map((n) => `/api/v1/drop/${n}`).sort(),
    );
    expect(caddy).toMatch(/request_body @drop_api \{\s*max_size 16KB\s*\}/);
    // Headers still within 10 seconds; the whole of a file within minutes.
    expect(caddy).toMatch(/read_header 10s/);
    expect(caddy).toMatch(/read_body 5m/);
  });

  it('sends every answer the headers a page facing strangers needs', () => {
    const block = /header \{([\s\S]*?)\n\t\}/.exec(caddy)?.[1] ?? '';
    expect(block).toMatch(/^\s*Referrer-Policy no-referrer$/m);
    expect(block).toMatch(/^\s*X-Content-Type-Options nosniff$/m);
    expect(block).toMatch(/^\s*X-Frame-Options DENY$/m);
    expect(block).toMatch(/^\s*Strict-Transport-Security /m);
    // Its own policy only where the page or the API sent none.
    const csp = /^\s*\?Content-Security-Policy "([^"]*)"$/m.exec(block)?.[1] ?? null;
    expectStrict(csp, 'Caddyfile.public-only');
    // And a caller's address is never one it wrote itself: no proxy in
    // front of it is trusted to say otherwise.
    const directives = caddy.replace(/^\s*#.*$/gm, '');
    expect(directives).not.toMatch(/trusted_proxies/);
  });

  it('is a compose profile of its own, which a plain start leaves off', async () => {
    const compose = await readFile(root('docker-compose.tls.yml'), 'utf8');
    const service = /\n {2}caddy-public:\n([\s\S]*?)\n(?=\S| {2}\S)/.exec(compose)?.[1] ?? '';
    expect(service).toMatch(/profiles: \[public-only\]/);
    expect(service).toContain('./docker/caddy/Caddyfile.public-only:/etc/caddy/Caddyfile:ro');
  });
});

/**
 * Who is asking (5.30): whose X-Forwarded-For reaches the API. nginx and
 * Caddy do not run here; their files are read and held to it. The API's own
 * rule is app.test.ts's and client-address.test.ts's.
 */
describe('the address a request came from', () => {
  it('nginx passes on the address it was reached from, never what the caller wrote', async () => {
    const conf = (await readFile(root('docker/nginx.conf'), 'utf8')).replace(/^\s*#.*$/gm, '');
    expect(conf).toMatch(/^\s*proxy_set_header X-Forwarded-For \$remote_addr;$/m);
    expect(conf).not.toMatch(/proxy_add_x_forwarded_for/);
    expect(conf.match(/X-Forwarded-For/g)).toHaveLength(1);
  });

  it("Caddy sends the API's requests to the API itself, and believes no proxy in front of it", async () => {
    for (const file of ['Caddyfile.internal', 'Caddyfile.public', 'Caddyfile.public-only']) {
      const caddy = (await readFile(root(`docker/caddy/${file}`), 'utf8')).replace(
        /^\s*#.*$/gm,
        '',
      );
      expect(caddy, file).toMatch(/reverse_proxy api:3000/);
      expect(caddy, file).not.toMatch(/trusted_proxies/);
      expect(caddy, file).not.toMatch(/header_up X-Forwarded-For/i);
    }
    for (const file of ['Caddyfile.internal', 'Caddyfile.public']) {
      const caddy = await readFile(root(`docker/caddy/${file}`), 'utf8');
      expect(caddy, file).toMatch(/^\s*@api path \/api\/\* \/healthz \/readyz$/m);
      expect(caddy, file).toMatch(/handle @api \{\s*reverse_proxy api:3000/);
      expect(caddy, file).toMatch(/handle \{\s*reverse_proxy web:80/);
    }
  });

  it("under the TLS overlay the API's requests are bounded as nginx bounded them (the 5.30 review, X530-3)", async () => {
    for (const file of ['Caddyfile.internal', 'Caddyfile.public']) {
      const caddy = (await readFile(root(`docker/caddy/${file}`), 'utf8')).replace(
        /^\s*#.*$/gm,
        '',
      );
      // The global options: the first block, before the site's.
      const global = /^\{([\s\S]*?)^\}/m.exec(caddy)?.[1] ?? '';
      const timeouts = /servers \{\s*timeouts \{([^}]*)\}\s*\}/.exec(global)?.[1] ?? '';
      expect(timeouts, file).toMatch(/^\s*read_header 10s$/m);
      expect(timeouts, file).toMatch(/^\s*idle 2m$/m);
      // Long enough for FDV_MAX_UPLOAD_BYTES (100 MB) at about 1.5 Mbit/s, and bounded.
      const body = /^\s*read_body (\d+)m$/m.exec(timeouts)?.[1];
      expect(Number(body), file).toBeGreaterThanOrEqual(10);
      expect(Number(body), file).toBeLessThanOrEqual(60);
    }
  });

  it(':8080 answers this machine only under the TLS overlay, and the network otherwise', async () => {
    const service = (compose: string, name: string) =>
      new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)\\n(?=\\S| {2}\\S)`).exec(compose)?.[1] ?? '';
    const tls = service(await readFile(root('docker-compose.tls.yml'), 'utf8'), 'web');
    expect(tls).toMatch(/ports: !override\n\s*- '127\.0\.0\.1:\$\{FDV_PORT:-8080\}:80'/);
    // The phones in the house reach the vault at this machine's address.
    const main = await readFile(root('docker-compose.yml'), 'utf8');
    expect(service(main, 'web')).toMatch(/ports:\n\s*- '\$\{FDV_PORT:-8080\}:80'/);
    expect(await readFile(root('docker-compose.dev.yml'), 'utf8')).not.toMatch(/127\.0\.0\.1/);
    // And the API believes the compose network, not the LAN, unless told otherwise.
    expect(service(main, 'api')).toMatch(/FDV_TRUST_PROXY: \$\{FDV_TRUST_PROXY:-network\}/);
  });
});

describe.skipIf(!testAdminUrl())('what the share routes answer with', () => {
  let h: Harness;
  let owner: Tokens;
  let doc: string;

  beforeAll(async () => {
    h = await createHarness({ publicUrl: 'https://share.example.test/' });
    owner = await h.setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Lease', type_key: 'utility_bill' },
    });
    doc = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', Buffer.from('%PDF-1.4\n%%EOF\n'), {
      filename: 'lease.pdf',
      contentType: 'application/pdf',
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
  }, 90_000);
  afterAll(() => h.close());

  it('every answer under /api/v1/shared carries the public headers, a refusal too', async () => {
    const made = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/share`,
        headers: h.as(owner),
        payload: {},
      })
    ).json<CreatedShare>();
    // On the public-only site, with the secret after the #.
    expect(made.link_url).toBe(`https://share.example.test/s#${made.link_token}`);

    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: made.link_token },
    });
    const cookie = opened.cookies.find((c) => c.name === 'fdv_share')?.value as string;
    const answers = [
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/preview',
        payload: { token: made.link_token },
      }),
      opened,
      await h.app.inject({ url: '/api/v1/shared/items', cookies: { fdv_share: cookie } }),
      await h.app.inject({
        url: `/api/v1/shared/items/${doc}/content`,
        cookies: { fdv_share: cookie },
      }),
      await h.app.inject({ url: '/api/v1/shared/items' }),
      await h.app.inject({ url: `/api/v1/shared/${'a'.repeat(43)}` }),
    ];
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200, 200, 401, 404]);
    for (const [n, a] of answers.entries()) {
      expect(a.headers['referrer-policy']).toBe('no-referrer');
      expect(a.headers['x-content-type-options']).toBe('nosniff');
      expect(a.headers['x-robots-tag']).toBe('noindex, nofollow');
      const csp = String(a.headers['content-security-policy']);
      expectStrict(csp, `answer ${n}`);
      // A shared file opened by mistake runs nothing.
      expect(csp).toMatch(/(^|; )sandbox(;|$)/);
    }
    // The family's own answers are not a stranger's.
    const own = await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) });
    expect(own.headers['content-security-policy']).toBeUndefined();
  });
});
