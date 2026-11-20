import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The compose files' containers, as a self-hoster runs them: each hardened
 * (no capabilities beyond what it needs, nothing gained through setuid, a
 * read-only root filesystem, ceilings on processes and memory), the API
 * without the owning role's password, and every image pinned by digest.
 * Read as text, block by block, as the files are written.
 */

const file = (name: string) => readFile(new URL(`../../../${name}`, import.meta.url), 'utf8');

/** One top-level service's block, comments left out: up to the next service or section. */
function block(text: string, name: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.indexOf(`  ${name}:`);
  expect(at, name).toBeGreaterThan(0);
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break;
    out.push(l);
  }
  return out.filter((l) => !l.trim().startsWith('#')).join('\n');
}

function hardened(service: string, name: string): void {
  expect(service, name).toMatch(/\n\s+cap_drop: \[ALL\]\n/);
  expect(service, name).toMatch(/\n\s+security_opt: \['no-new-privileges:true'\]\n/);
  expect(service, name).toMatch(/\n\s+read_only: true\n/);
  expect(service, name).toMatch(/\n\s+pids_limit: /);
  expect(service, name).toMatch(/\n\s+mem_limit: /);
}

describe('the compose files', () => {
  it('harden every container the vault runs, and give back only binding low ports to Caddy', async () => {
    const main = await file('docker-compose.yml');
    for (const name of ['migrate', 'api', 'worker', 'web']) {
      const service = block(main, name);
      hardened(service, name);
      expect(service, name).not.toMatch(/cap_add/);
    }
    const tls = await file('docker-compose.tls.yml');
    for (const name of ['caddy', 'caddy-public']) {
      const service = block(tls, name);
      hardened(service, name);
      expect(service, name).toMatch(/\n\s+cap_add: \[NET_BIND_SERVICE\]\n/);
    }
    // Postgres's entrypoint drops to its own user itself: it gains nothing more.
    expect(block(main, 'postgres')).toMatch(/security_opt: \['no-new-privileges:true'\]/);
  });

  it("keep the owning role's password from the API, which waits for the migrate service", async () => {
    const main = await file('docker-compose.yml');
    const api = block(main, 'api');
    expect(api).not.toMatch(/DATABASE_ADMIN_URL/);
    expect(api).toMatch(/migrate:\n\s+condition: service_completed_successfully/);
    const migrate = block(main, 'migrate');
    expect(migrate).toMatch(/DATABASE_ADMIN_URL: /);
    expect(migrate).toContain("command: ['node', 'apps/api/dist/cli.mjs', 'migrate']");
    expect(migrate).toMatch(/restart: 'no'/);
    // The api's image, so it is pulled and built with it.
    expect(migrate).toContain(
      'image: ghcr.io/mansoor/family-documents-vault/api:${FDV_VERSION:-latest}',
    );
    // The worker keeps it, for backups and restores, and waits for migrate too.
    const worker = block(main, 'worker');
    expect(worker).toMatch(/DATABASE_ADMIN_URL: /);
    expect(worker).toMatch(/migrate:\n\s+condition: service_completed_successfully/);
    // No new required variable: an existing .env starts the same stack.
    for (const name of ['migrate', 'api', 'worker']) {
      expect(block(main, name), name).not.toMatch(/\$\{FDV_MASTER_KEY:\?/);
    }
  });

  it('reach nginx on 8080, which it listens on beside 80 for compose files and Caddyfiles from before', async () => {
    const nginx = (await file('docker/nginx.conf')).replace(/^\s*#.*$/gm, '');
    expect(nginx).toMatch(/^\s*listen 8080;$/m);
    expect(nginx).toMatch(/^\s*listen 80;$/m);
    const main = await file('docker-compose.yml');
    // Unset, FDV_BIND leaves the port on every interface, IPv4 and IPv6, as before.
    expect(block(main, 'web')).toMatch(
      /- '\$\{FDV_BIND:\+\$\{FDV_BIND\}:\}\$\{FDV_PORT:-8080\}:8080'/,
    );
    for (const caddy of [
      'Caddyfile.internal',
      'Caddyfile.public',
      'Caddyfile.public-only',
      'apps-on.caddy',
    ]) {
      const text = await file(`docker/caddy/${caddy}`);
      expect(text, caddy).toMatch(/reverse_proxy web:8080 /);
      expect(text, caddy).not.toMatch(/reverse_proxy web:80 /);
    }
    const dockerfile = await file('Dockerfile');
    expect(dockerfile).toContain('wget -qO- http://127.0.0.1:8080/');
  });

  it('pin every image they pull by digest, and the Dockerfile every base', async () => {
    const pinned = /@sha256:[0-9a-f]{64}$/;
    for (const name of ['docker-compose.yml', 'docker-compose.tls.yml', 'docker-compose.dev.yml']) {
      const images = [...(await file(name)).matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1]);
      expect(images.length, name).toBeGreaterThan(0);
      for (const image of images) {
        // The vault's own images are chosen by FDV_VERSION (README, "Upgrading").
        if (image?.startsWith('ghcr.io/mansoor/family-documents-vault/')) continue;
        expect(image, `${name}: ${image}`).toMatch(pinned);
      }
    }
    const dockerfile = await file('Dockerfile');
    expect(dockerfile.split('\n')[0]).toMatch(/^# syntax=docker\/dockerfile:[\d.]+@sha256:/);
    const bases = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1] as string);
    const stages = new Set([...dockerfile.matchAll(/^FROM \S+ AS (\S+)/gm)].map((m) => m[1]));
    for (const base of bases) {
      if (stages.has(base)) continue;
      expect(base).toMatch(pinned);
    }
  });

  it("send ImageMagick's pixel cache to the worker's /tmp, where its start sweeps leftovers", async () => {
    const worker = block(await file('docker-compose.yml'), 'worker');
    expect(worker).toMatch(/\n\s+MAGICK_TEMPORARY_PATH: \/tmp\n/);
    expect(worker).toMatch(/\n\s+- worker-tmp:\/tmp\n/);
  });

  it('pin the images CI runs its jobs and services in by digest', async () => {
    const ci = await file('.github/workflows/ci.yml');
    const images = [
      ...[...ci.matchAll(/^\s+(?:image|container): (\S+)$/gm)].map((m) => m[1]),
      ...[...ci.matchAll(/docker run [^\n]*?\s([\w./-]+:[\w.-]+(?:@\S+)?)(?: posix|$)/gm)].map(
        (m) => m[1],
      ),
    ];
    expect(images.length).toBeGreaterThanOrEqual(5);
    for (const image of images) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('pin every GitHub Action by its commit, with its release beside it', async () => {
    const ci = await file('.github/workflows/ci.yml');
    const uses = [...ci.matchAll(/uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, action, rest] of uses) {
      expect(action, action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, action).toMatch(/^ # v\d+\.\d+\.\d+$/);
    }
  });
});
