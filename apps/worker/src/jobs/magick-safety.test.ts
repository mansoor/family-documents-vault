import type * as ChildProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ImageMagick is never handed a file of the family's to guess at (0.9.0,
 * security before launch). A file stored as a PNG whose bytes are an MVG
 * drawing script or an SVG — which ImageMagick reads by their content, and
 * which can read the worker's own files into the picture or fetch from the
 * network — is refused before any tool sees it; every file it is handed is
 * named with its coder; and the worker image's policy.xml refuses those
 * coders besides.
 *
 * The tools themselves are stood in for here (child_process.execFile), so
 * this runs where ImageMagick is not installed: what matters is what each
 * would have been handed. The image's own build proves the policy in force.
 */

interface Call {
  bin: string;
  args: string[];
}
interface Ran {
  calls: Call[];
  /** What the stood-in ImageMagick does with an MVG read: refused by policy, or not. */
  policy: 'refuses' | 'reads';
}
const ran = vi.hoisted((): Ran => ({ calls: [], policy: 'refuses' }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import('node:util');
  const fs = await import('node:fs/promises');
  const run = async (bin: string, args: string[]) => {
    // A capped tool runs through `sh -c '… exec "$0" "$@"' tool args…` on Linux.
    const call = bin === 'sh' ? { bin: args[2] as string, args: args.slice(3) } : { bin, args };
    ran.calls.push(call);
    if (call.bin === 'magick' && call.args.some((a) => a.startsWith('mvg:'))) {
      if (ran.policy === 'refuses') {
        throw Object.assign(new Error('Command failed'), {
          stderr:
            "magick: attempt to perform an operation not allowed by the security policy `MVG' @ error/constitute.c/IsCoderAuthorized/422.",
        });
      }
    }
    // Whatever a tool would write, written: pdftoppm's page, ImageMagick's output.
    const last = call.args[call.args.length - 1] ?? '';
    if (call.bin === 'pdftoppm') await fs.writeFile(`${last}.png`, 'drawn page');
    if (call.bin === 'magick' && /^[a-z]+:/.test(last)) {
      await fs.writeFile(last.replace(/^[a-z]+:/, ''), 'drawn');
    }
    return { stdout: '', stderr: '' };
  };
  const execFile = Object.assign(
    (..._args: unknown[]) => {
      throw new Error('only the promisified form is used');
    },
    { [promisify.custom]: run },
  );
  return { ...real, execFile };
});

const tools = await import('./tools.js');
const { wholeBufferJpeg } = await import('./jpeg-test-helper.js');

const root = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
/** What a stranger would send as a PNG to read the worker's own files, and fetch. */
const MVG =
  "push graphic-context\nviewbox 0 0 640 480\nimage over 0,0 0,0 'text:/proc/1/environ'\nimage over 0,0 0,0 'url:http://169.254.169.254/'\npop graphic-context\n";
const SVG =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="text:/etc/passwd"/></svg>';
const MSL =
  '<?xml version="1.0"?><image><read filename="/etc/passwd"/><write filename="x.png"/></image>';

/** Every argument that names a file in `dir`, as ImageMagick was handed it. */
const filesNamed = (calls: Call[], dir: string) =>
  calls.flatMap((c) => c.args).filter((a) => a.includes(path.basename(dir)));

describe('what ImageMagick is handed (0.9.0)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-magick-safety-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    ran.calls.length = 0;
    ran.policy = 'refuses';
  });

  const magickRuns = () =>
    ran.calls.filter((c) => c.bin === 'magick' && !c.args.includes('-version'));

  it('a drawing script, an SVG or MSL stored as a PNG is never handed to ImageMagick', async () => {
    for (const [name, bytes] of [
      ['script.png', MVG],
      ['drawing.png', SVG],
      ['program.png', MSL],
      ['plain.png', 'just words'],
    ] as const) {
      const file = path.join(dir, name);
      await writeFile(file, bytes);
      const out = path.join(dir, `${name}.thumb.jpg`);
      await expect(tools.thumbnail(file, out, 'image/png'), name).rejects.toBeInstanceOf(
        tools.KindRefused,
      );
      await expect(
        tools.renderPreviews(file, 'image/png', dir, 5),
        `${name} previews`,
      ).rejects.toBeInstanceOf(tools.KindRefused);
      await expect(
        tools.imagePage(file, 'image/png', dir, 0),
        `${name} page`,
      ).rejects.toBeInstanceOf(tools.KindRefused);
      // As a JPEG, a TIFF, a HEIC or a PDF, the same.
      for (const mime of [
        'image/jpeg',
        'image/tiff',
        'image/heic',
        'image/webp',
        'application/pdf',
      ]) {
        await expect(tools.thumbnail(file, out, mime), `${name} as ${mime}`).rejects.toBeInstanceOf(
          tools.KindRefused,
        );
      }
    }
    expect(magickRuns()).toEqual([]);
    expect(ran.calls.filter((c) => c.bin === 'pdftoppm' || c.bin === 'tesseract')).toEqual([]);
  });

  it('a kind the vault does not draw is refused, whatever its bytes', async () => {
    const file = path.join(dir, 'real.png');
    await writeFile(file, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64)]));
    for (const mime of ['image/svg+xml', 'image/gif', 'text/plain', 'application/octet-stream']) {
      await expect(tools.thumbnail(file, path.join(dir, 't.jpg'), mime), mime).rejects.toThrow(
        /draws no/,
      );
    }
    expect(magickRuns()).toEqual([]);
  });

  it('a picture is read only with its own coder, its first frame, and written as a JPEG', async () => {
    const cases: Array<[string, Buffer, string, string]> = [
      ['photo.png', Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64)]), 'image/png', 'png'],
      ['photo.jpg', wholeBufferJpeg(16, 16, 1, 'sequential'), 'image/jpeg', 'jpeg'],
      ['scan.tif', Buffer.from('49492a0008000000', 'hex'), 'image/tiff', 'tiff'],
      [
        'photo.webp',
        Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(32)]),
        'image/webp',
        'webp',
      ],
      [
        'photo.heic',
        Buffer.concat([Buffer.from('\0\0\0\x18ftypheic', 'latin1'), Buffer.alloc(32)]),
        'image/heif',
        'heic',
      ],
    ];
    for (const [name, bytes, mime, coder] of cases) {
      ran.calls.length = 0;
      const file = path.join(dir, name);
      await writeFile(file, bytes);
      const out = path.join(dir, `${name}.thumb.jpg`);
      await tools.thumbnail(file, out, mime);
      const [draw, ...more] = magickRuns();
      expect(more, name).toEqual([]);
      expect(draw?.args, name).toContain(`${coder}:${file}[0]`);
      expect(draw?.args.at(-1), name).toBe(`jpeg:${out}`);
      // No file is named bare, for ImageMagick to guess at.
      for (const arg of filesNamed([draw as Call], dir)) {
        expect(arg, name).toMatch(/^(png|jpeg|tiff|webp|heic):/);
      }
    }
  });

  it("a PDF's first page is drawn by poppler, and that page read as a PNG", async () => {
    const file = path.join(dir, 'letter.pdf');
    await writeFile(file, '%PDF-1.4\n%%EOF\n');
    const out = path.join(dir, 'letter.thumb.jpg');
    await tools.thumbnail(file, out, 'application/pdf');
    const [draw] = magickRuns();
    expect(draw?.args).toContain(`png:${path.join(dir, 'thumb-src')}.png`);
    expect(draw?.args.at(-1)).toBe(`jpeg:${out}`);
    for (const arg of filesNamed([draw as Call], dir)) expect(arg).toMatch(/^(png|jpeg):/);
  });

  it('every page preview and every page read names its coder too', async () => {
    const file = path.join(dir, 'page.jpg');
    await writeFile(file, wholeBufferJpeg(16, 16, 1, 'sequential'));
    await tools.renderPreviews(file, 'image/jpeg', dir, 5);
    for (const arg of filesNamed(magickRuns(), dir)) expect(arg).toMatch(/^(png|jpeg):/);
  });

  it('says whether the policy refuses an MVG drawing', async () => {
    expect(await tools.magickPolicy(dir)).toBe('enforced');
    // The probe is read by its coder's name: mvg:, never a bare file.
    expect(ran.calls.at(-1)?.args[0]).toMatch(/^mvg:/);
    ran.policy = 'reads';
    expect(await tools.magickPolicy(dir)).toBe('absent');
  });
});

describe("the worker image's ImageMagick policy (0.9.0)", () => {
  let dockerfile: string;
  let policy: string;
  beforeAll(async () => {
    dockerfile = await readFile(root('Dockerfile'), 'utf8');
    policy = await readFile(root('docker/imagemagick/policy.xml'), 'utf8');
  });

  const worker = () => {
    const from = dockerfile.indexOf('AS worker');
    const to = dockerfile.indexOf('AS web');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return dockerfile.slice(from, to);
  };

  it('is copied into the worker image, and proved in force as it is built', () => {
    const stage = worker();
    expect(stage).toContain('COPY docker/imagemagick/policy.xml /etc/ImageMagick-7/policy.xml');
    // After ImageMagick is installed, which would otherwise put its own back.
    expect(stage.indexOf('COPY docker/imagemagick/policy.xml')).toBeGreaterThan(
      stage.indexOf('apk add'),
    );
    // An MVG drawing must be refused by the policy, or the build fails.
    expect(stage).toMatch(/magick mvg:\/tmp\/probe\.mvg png:\/tmp\/probe\.png/);
    expect(stage).toContain(
      "grep -qE 'not (allowed|authorized) by the security policy' /tmp/probe.err",
    );
    expect(tools.MAGICK_POLICY_REFUSAL.source).toBe(
      'not (allowed|authorized) by the security policy',
    );
    // What Alpine's ImageMagick 7.1 says, word for word.
    expect(
      tools.MAGICK_POLICY_REFUSAL.test(
        "magick: attempt to perform an operation not authorized by the security policy `MVG' @ error/constitute.c/IsCoderAuthorized/456.",
      ),
    ).toBe(true);
    // Never into the API's image, which draws nothing.
    const api = dockerfile.slice(dockerfile.indexOf('AS api'), dockerfile.indexOf('AS worker'));
    expect(api).not.toContain('policy.xml');
  });

  it('refuses every delegate, the coders that run scripts or reach outside, and @files', () => {
    expect(policy).toMatch(/<policy domain="delegate" rights="none" pattern="\*"\/>/);
    const coders = /<policy domain="coder" rights="none" pattern="\{([A-Z0-9,]+)\}"\/>/.exec(
      policy,
    );
    expect(coders).not.toBeNull();
    const denied = new Set((coders?.[1] ?? '').split(','));
    for (const c of [
      'MVG',
      'MSL',
      'SVG',
      'MSVG',
      'TEXT',
      'LABEL',
      'URL',
      'HTTP',
      'HTTPS',
      'FTP',
      'EPHEMERAL',
      'PS',
      'EPS',
      'PDF',
      'XPS',
    ]) {
      expect(denied.has(c), c).toBe(true);
    }
    // And none the worker uses: the pictures it takes, a page drawn, a
    // watermark laid out with pango and tiled, a size asked.
    for (const c of ['PNG', 'JPEG', 'WEBP', 'TIFF', 'HEIC', 'PANGO', 'TILE', 'INFO']) {
      expect(denied.has(c), c).toBe(false);
    }
    expect(policy).toMatch(/<policy domain="path" rights="none" pattern="@\*"\/>/);
  });

  it('limits every run at least as tightly as the worker asks, and never below it', () => {
    const limit = (name: string) =>
      new RegExp(`<policy domain="resource" name="${name}" value="([^"]+)"/>`).exec(policy)?.[1];
    const asked = (name: string) => {
      const at = tools.MAGICK_LIMITS.indexOf(name);
      return at > 0 ? tools.MAGICK_LIMITS[at + 1] : undefined;
    };
    const amount = (v: string | undefined) => {
      const m = /^(\d+)(KP|MP|MiB|GiB)?$/.exec(v ?? '');
      if (!m) return NaN;
      const unit = { KP: 1e3, MP: 1e6, MiB: 2 ** 20, GiB: 2 ** 30 }[m[2] ?? ''] ?? 1;
      return Number(m[1]) * unit;
    };
    for (const name of ['memory', 'map', 'area', 'width', 'height', 'disk', 'time']) {
      expect(limit(name), name).toBeDefined();
      // A run may lower a limit, never raise it: the policy's must not be under what a run asks.
      expect(amount(limit(name)), name).toBeGreaterThanOrEqual(amount(asked(name)));
    }
    // A photo's decode asks for 2 GiB of disk (PHOTO_LIMITS).
    expect(amount(limit('disk'))).toBeGreaterThanOrEqual(2 * 2 ** 30);
    // And nothing unbounded.
    expect(amount(limit('memory'))).toBeLessThanOrEqual(2 ** 30);
    expect(amount(limit('time'))).toBeLessThanOrEqual(300);
  });
});
