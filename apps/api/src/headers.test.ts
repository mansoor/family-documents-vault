import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
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

/**
 * The page's one inline script, the theme's (0.9.0): what it is, and the
 * hash a policy allows it by — that script and no other, not inline script
 * in general. Read from the file, so a change to it fails here until the
 * hash in docker/nginx.conf is changed with it.
 */
async function themeScript(): Promise<{ body: string; hash: string }> {
  const shell = await readFile(root('apps/web/index.html'), 'utf8');
  const inline = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  expect(inline).toHaveLength(1);
  const body = inline[0] as string;
  return { body, hash: `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'` };
}

/** A strict policy: nothing from anywhere by default, no inline or evaluated script, no frames. */
function expectStrict(csp: string | null, what: string, theme?: string) {
  expect(csp, what).not.toBeNull();
  const policy = csp as string;
  expect(policy, what).toMatch(/(^|; )default-src 'none'(;|$)/);
  expect(policy, what).toMatch(/(^|; )frame-ancestors 'none'(;|$)/);
  expect(policy, what).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  const script = /script-src ([^;]*)/.exec(policy)?.[1];
  // The vault's own files; on the page itself, and the theme's few lines by their hash.
  if (script !== undefined) {
    expect(script.trim(), what).toBe(theme ? `'self' ${theme}` : "'self'");
  }
}

describe('the pages a link opens', () => {
  it('every public page is sent no referrer, no sniffing, no framing and a strict policy', async () => {
    const conf = await readFile(root('docker/nginx.conf'), 'utf8');
    const { hash } = await themeScript();
    for (const opening of [
      'location ~ ^/s/?$ {',
      'location ^~ /shared/ {',
      // A request to send documents' page (5.21; the page itself is 5.22's).
      'location ~ ^/drop/?$ {',
      // A connected app's view link's page (0.9.0, APP3).
      'location ~ ^/a/?$ {',
    ]) {
      const block = nginxBlock(conf, opening);
      expect(added(block, 'Referrer-Policy'), opening).toBe('no-referrer');
      expect(added(block, 'X-Content-Type-Options'), opening).toBe('nosniff');
      expect(added(block, 'X-Frame-Options'), opening).toBe('DENY');
      expectStrict(added(block, 'Content-Security-Policy'), opening, hash);
      // The page itself, not a route of the app's that might send others.
      expect(block, opening).toContain('try_files /index.html =404;');
    }
  });

  it('the app itself runs scripts from the vault only, and nothing inline but the theme’s (5.35, 0.9.0)', async () => {
    const conf = await readFile(root('docker/nginx.conf'), 'utf8');
    const csp = added(nginxBlock(conf, 'location / {'), 'Content-Security-Policy');
    expect(csp).not.toBeNull();
    const directives = new Map(
      (csp as string).split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values.join(' ')] as const;
      }),
    );
    const theme = await themeScript();
    expect(directives.get('script-src')).toBe(`'self' ${theme.hash}`);
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    // And the page it serves has no other script of its own to allow: the
    // theme's few lines, and one module by address.
    const shell = await readFile(root('apps/web/index.html'), 'utf8');
    const scripts = [...shell.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map((s) => [/\bsrc="([^"]+)"/.exec(s[1] ?? '')?.[1], s[2]?.trim()])).toEqual([
      [undefined, theme.body.trim()],
      ['/src/main.tsx', ''],
    ]);
    // The theme's lines read storage and a media query, and set the theme: nothing else.
    expect(theme.body).not.toMatch(/fetch|XMLHttpRequest|eval|Function|import|innerHTML|cookie/);
    expect(shell).not.toMatch(/\son[a-z]+=/i);
    // Before the stylesheet: a dark page is never drawn light first.
    expect(shell.indexOf('<script>')).toBeLessThan(shell.indexOf('rel="stylesheet"'));
  });

  it('the signed-in app is never framed, sends no referrer beyond itself, and asks for no powers it never uses', async () => {
    const conf = await readFile(root('docker/nginx.conf'), 'utf8');
    const block = nginxBlock(conf, 'location / {');
    const csp = added(block, 'Content-Security-Policy') as string;
    expect(csp).toMatch(/(^|; )frame-ancestors 'none'(;|$)/);
    expect(added(block, 'X-Frame-Options')).toBe('DENY');
    expect(added(block, 'Referrer-Policy')).toBe('same-origin');
    expect(added(block, 'X-Content-Type-Options')).toBe('nosniff');
    const powers = added(block, 'Permissions-Policy') as string;
    for (const power of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(powers, power).toContain(`${power}=()`);
    }
    // Passkeys, sharing and copying a link stay the app's own.
    expect(powers).not.toMatch(/publickey-credentials|web-share|clipboard/);
    // The app frames nothing of its own that these would stop.
    const sources = await readdir(root('apps/web/src'), { recursive: true });
    for (const file of sources.filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))) {
      const text = await readFile(root(`apps/web/src/${file}`), 'utf8');
      expect(text, file).not.toMatch(/<iframe|<frame\b|<embed\b|<object\b/i);
    }
    // The pages outsiders open keep their own, stricter, headers (above),
    // and the hashed assets need none.
    expect(nginxBlock(conf, 'location /assets/ {')).not.toMatch(/X-Frame-Options/);
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

  it("adds the connected apps' routes and the capability document only with FDV_PUBLIC_APPS=on (0.9.0, APP1)", async () => {
    expect(caddy).toMatch(/^\s*import \/etc\/caddy\/apps\.caddy$/m);
    // The import comes before the 404 that answers everything else.
    expect(caddy.indexOf('import /etc/caddy/apps.caddy')).toBeLessThan(
      caddy.lastIndexOf('respond 404'),
    );
    const on = (await readFile(root('docker/caddy/apps-on.caddy'), 'utf8')).replace(
      /^\s*#.*$/gm,
      '',
    );
    const off = (await readFile(root('docker/caddy/apps-off.caddy'), 'utf8')).replace(
      /^\s*#.*$/gm,
      '',
    );
    // Off adds nothing it serves: only the guard below.
    expect(off).not.toMatch(/reverse_proxy|@apps_api/);
    // The capability document asked this way is told so, whatever the caller wrote.
    expect(on).toMatch(/reverse_proxy api:3000 \{[^}]*header_up X-FDV-Site public/);
    const paths = (/^\s*@apps_api path (.+)$/m.exec(on)?.[1] ?? '').trim().split(/\s+/);
    expect(paths.sort()).toEqual(['/api/v1/app-links/*', '/api/v1/apps/*', '/api/v1/capabilities']);
    expect(on).toMatch(/handle @apps_api \{\s*reverse_proxy api:3000/);
    // And (APP3) the page a view link opens, from the web container: that
    // page alone.
    const page = (/^\s*@apps_page path (.+)$/m.exec(on)?.[1] ?? '').trim().split(/\s+/);
    expect(page.sort()).toEqual(['/a', '/a/']);
    expect(on).toMatch(/handle @apps_page \{\s*reverse_proxy web:80/);
    expect(on.match(/reverse_proxy /g)).toHaveLength(2);
    expect(off).not.toMatch(/@apps_page/);
    for (const shown of ['/api/v1/app-links/abc', '/api/v1/app-links/session/pages/1']) {
      expect(caddyMatches(paths, shown), shown).toBe(true);
    }
    // A link's address is a page (GET) and its open (POST, 0.9.0-dev.68):
    // nothing here, nor in nginx, limits the method.
    expect(on).not.toMatch(/\bmethod\b/);
    expect(await readFile(root('docker/nginx.conf'), 'utf8')).not.toMatch(/limit_except/);
    for (const hidden of ['/api/v1/app-linksx', '/ab', '/a/b']) {
      expect(caddyMatches([...paths, ...page], hidden), hidden).toBe(false);
    }
    for (const hidden of ['/api/v1/connected-apps', '/api/v1/documents', '/api/v1/appsx', '/a']) {
      expect(caddyMatches(paths, hidden), hidden).toBe(false);
    }
    for (const shown of ['/api/v1/apps/me', '/api/v1/apps/intake/mt:1', '/api/v1/capabilities']) {
      expect(caddyMatches(paths, shown), shown).toBe(true);
    }
    const compose = await readFile(root('docker-compose.tls.yml'), 'utf8');
    expect(compose).toContain(
      './docker/caddy/apps-${FDV_PUBLIC_APPS:-off}.caddy:/etc/caddy/apps.caddy:ro',
    );
  });

  it('answers 404 for a raw path that hides a slash, a backslash or a dot, before anything else (APP1 review)', async () => {
    const on = await readFile(root('docker/caddy/apps-on.caddy'), 'utf8');
    const off = await readFile(root('docker/caddy/apps-off.caddy'), 'utf8');
    const nginx = await readFile(root('docker/nginx.conf'), 'utf8');
    // Caddy's: in the site, first, and in each fragment it imports.
    const guard = (text: string, name: string) => {
      const m = /^\s*@(\w+) expression `\{http\.request\.uri\}\.matches\("(.+)"\)`$/m.exec(text);
      expect(m?.[1], name).toBe(name);
      expect(text).toMatch(new RegExp(String.raw`handle @${name} \{\s*respond 404\s*\}`));
      // RE2's inline case flag, as a JavaScript flag.
      return new RegExp((m?.[2] as string).replace('(?i:', '('), 'i');
    };
    const site = guard(caddy, 'bad_uri');
    expect(caddy.indexOf('handle @bad_uri')).toBeLessThan(caddy.indexOf('handle @public'));
    const fragments = [guard(on, 'apps_bad_uri'), guard(off, 'apps_bad_uri')];
    // nginx's, on the path alone, before any location.
    const n = /if \(\$fdv_log_path ~\* "(.+)"\) \{\s*return 404;\s*\}/.exec(nginx);
    expect(n).not.toBeNull();
    expect(nginx.indexOf('return 404;')).toBeLessThan(nginx.indexOf('location '));
    const nginxRe = new RegExp(n?.[1] as string, 'i');
    for (const bad of [
      '/shared/%2e%2e/api/v1/documents',
      '/shared/..%2Fapi/v1/documents',
      '/drop/x%5c..%5capi',
      '/api/v1/apps/intake/%2E%2E',
      '/shared/./x',
      '/api/v1/apps/../documents',
    ]) {
      for (const re of [site, ...fragments]) expect(re.test(bad), bad).toBe(true);
      expect(nginxRe.test(bad.split('?')[0] as string), bad).toBe(true);
    }
    for (const fine of [
      '/s',
      '/shared/abcdef0123456789/open',
      '/api/v1/apps/intake/mt:tenant-7f3a:doc.01',
      '/api/v1/apps/intake?external_ids=a%2Fb,c.d',
      '/assets/index-abc123.js',
    ]) {
      for (const re of [site, ...fragments]) expect(re.test(fine), fine).toBe(false);
      expect(nginxRe.test(fine.split('?')[0] as string), fine).toBe(false);
    }
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
