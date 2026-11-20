import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepWorkerTemp, WORKER_TEMP_MIN_AGE_MS } from './temp-sweep.js';

const HOUR = 60 * 60 * 1000;

describe("the worker's temporary folder, on start", () => {
  let dir: string;
  const now = Date.now();
  /** Sets an entry's last change to `ago` milliseconds before `now`. */
  const age = (name: string, ago: number) =>
    utimes(path.join(dir, name), new Date(now - ago), new Date(now - ago));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sweep-'));
    await mkdir(path.join(dir, 'fdv-pv-old', 'pages-x'), { recursive: true });
    await writeFile(path.join(dir, 'fdv-pv-old', 'pages-x', 'page-1.png'), 'plain bytes');
    await mkdir(path.join(dir, 'fdv-export-old'));
    await writeFile(path.join(dir, 'magick-old'), 'pixels');
    await mkdir(path.join(dir, 'fdv-in-young'));
    await writeFile(path.join(dir, 'magick-young'), 'pixels');
    await writeFile(path.join(dir, 'someone-elses.txt'), 'kept');
    for (const old of ['fdv-pv-old', 'fdv-export-old', 'magick-old', 'someone-elses.txt']) {
      await age(old, 7 * HOUR);
    }
    await age('fdv-in-young', 5 * HOUR);
    await age('magick-young', 60_000);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('waits at least 6 hours: longer than any job may run', () => {
    expect(WORKER_TEMP_MIN_AGE_MS).toBeGreaterThanOrEqual(6 * HOUR);
  });

  it("in the image, removes the worker's and ImageMagick's leftovers once old, and nothing younger or else", async () => {
    expect(await sweepWorkerTemp(dir, { NODE_ENV: 'production' }, now)).toBe(3);
    expect((await readdir(dir)).sort()).toEqual([
      'fdv-in-young',
      'magick-young',
      'someone-elses.txt',
    ]);
  });

  it('anything younger than the age is left alone: another worker may still be at work in it', async () => {
    await age('fdv-pv-old', WORKER_TEMP_MIN_AGE_MS - 1000);
    expect(await sweepWorkerTemp(dir, { NODE_ENV: 'production' }, now)).toBe(2);
    expect(await readdir(dir)).toContain('fdv-pv-old');
  });

  it('anywhere else, touches nothing: the tests make folders of the same names', async () => {
    expect(await sweepWorkerTemp(dir, { NODE_ENV: 'test' }, now)).toBe(0);
    expect(await readdir(dir)).toHaveLength(6);
  });

  it('a folder that is not there is nothing to do', async () => {
    expect(await sweepWorkerTemp(path.join(dir, 'missing'), { NODE_ENV: 'production' }, now)).toBe(
      0,
    );
  });
});
