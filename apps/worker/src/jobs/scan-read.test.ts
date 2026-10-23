import { describe, expect, it } from 'vitest';
import {
  bestTurn,
  betterSkew,
  layoutText,
  MAX_OCR_WORDS,
  pageSkew,
  parseTsv,
  parseTsvPage,
  readingQuality,
  readScanPage,
  readsWell,
  REREAD_MARGIN,
  scaleFor,
  SECOND_LOOK_MS,
  SIDEWAYS_ABOVE,
  cappedScale,
  MAX_LINES_A_ROW,
  MIN_LAYOUT_SKEW,
  OSD_MIN_CONFIDENCE,
  PREPARE_MAX_PIXELS,
  rowFit,
  type Preparation,
  type OcrPage,
  type OcrWord,
  type ScanTools,
} from './scan-read.js';

/**
 * Reading a scan better (0.9.0, R3): Tesseract's words with their places,
 * laid out in the page's rows, straightened, and a page read badly turned,
 * made bigger and evened out. These are the steps without the tools; the
 * tools' own limits are tested in extract-text.test.ts and scan-limits.test.ts.
 */

/** A word at a place, 10 pixels a letter and 30 tall, read surely. */
const word = (
  text: string,
  left: number,
  top: number,
  where: { block?: number; line?: number; conf?: number } = {},
): OcrWord => ({
  block: where.block ?? 1,
  par: 1,
  line: where.line ?? 1,
  left,
  top,
  width: text.length * 10,
  height: 30,
  conf: where.conf ?? 95,
  text,
});

/** A line of words from `left`, a letter's width apart. */
const line = (
  words: string,
  left: number,
  top: number,
  where: { block?: number; line?: number; slope?: number; conf?: number } = {},
): OcrWord[] => {
  const out: OcrWord[] = [];
  let x = left;
  for (const w of words.split(' ')) {
    out.push(word(w, x, top + (where.slope ?? 0) * (x - left), where));
    x += w.length * 10 + 10;
  }
  return out;
};

/** Tesseract's TSV of these words. */
const tsv = (words: OcrWord[]) =>
  [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t2480\t3508\t-1\t',
    ...words.map(
      (w, i) =>
        `5\t1\t${w.block}\t${w.par}\t${w.line}\t${i + 1}\t${w.left}\t${w.top}\t${w.width}\t${w.height}\t${w.conf}\t${w.text}`,
    ),
  ].join('\n');

describe('reading a scan in its rows (R3)', () => {
  it('parses Tesseract’s table: its words, with their boxes, and nothing else', () => {
    const words = [...line('Payment date', 100, 200), word('12/05/2026', 900, 200, { block: 2 })];
    const parsed = parseTsv(
      `${tsv(words)}\n4\t1\t1\t1\t1\t0\t100\t200\t500\t30\t-1\t\n5\t1\t1\t1\t1\t9\tx\t1\t1\t1\t90\tbad\n5\t1\t1\t1\t1\t9\t1\t1\t0\t1\t90\tnil\n5\t1\t1\t1\t1\t9\t1\t1\t5\t5\t90\t   `,
    );
    expect(parsed.map((w) => w.text)).toEqual(['Payment', 'date', '12/05/2026']);
    expect(parsed[2]).toMatchObject({
      block: 2,
      left: 900,
      top: 200,
      width: 100,
      height: 30,
      conf: 95,
    });
  });

  it('measures how much of the page Tesseract took for a picture: its blocks with no words', () => {
    const table = [
      '1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t',
      '2\t1\t1\t0\t0\t0\t100\t100\t800\t100\t-1\t',
      '5\t1\t1\t1\t1\t1\t100\t100\t80\t30\t96\tDate',
      // A block that is a picture: its one "word" empty.
      '2\t1\t2\t0\t0\t0\t0\t500\t1000\t1000\t-1\t',
      '5\t1\t2\t1\t1\t1\t0\t500\t1000\t1000\t95\t ',
    ].join('\n');
    const page = parseTsvPage(table);
    expect(page.words.map((w) => w.text)).toEqual(['Date']);
    expect(page.unread).toBeCloseTo(0.5, 5);
    expect(parseTsvPage('').unread).toBe(0);
  });

  it('takes no more than MAX_OCR_WORDS words of a table, however long', () => {
    const row = '5\t1\t1\t1\t1\t1\t1\t1\t10\t10\t90\tword';
    const huge = Array.from({ length: MAX_OCR_WORDS + 5_000 }, () => row).join('\n');
    const started = performance.now();
    const parsed = parseTsv(huge);
    expect(parsed).toHaveLength(MAX_OCR_WORDS);
    // And lays them out in good time: no step is quadratic in the words.
    layoutText(parsed);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('puts a label and the value Tesseract read as another block on one row, far apart', () => {
    // Tesseract's blocks: the labels down the left, the values down the right.
    const words = [
      ...line('Statement date', 100, 300, { block: 1, line: 1 }),
      ...line('Payment due', 100, 350, { block: 1, line: 2 }),
      ...line('18 August 2026', 900, 302, { block: 2, line: 1 }),
      ...line('3 September 2026', 900, 351, { block: 2, line: 2 }),
    ];
    const text = layoutText(words);
    const rows = text.split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^Statement date {20,}18 August 2026$/);
    expect(rows[1]).toMatch(/^Payment due {20,}3 September 2026$/);
    // The words of one of Tesseract's lines a space apart.
    expect(rows[0]).toContain('Statement date');
  });

  it('two columns of a page read side by side, each label still with its value', () => {
    const words = [
      ...line('Policy number', 100, 300, { block: 1, line: 1 }),
      ...line('HX-4471', 300, 300, { block: 1, line: 1 }),
      ...line('Renewal date', 1300, 301, { block: 3, line: 1 }),
      ...line('01/06/2027', 1500, 301, { block: 3, line: 1 }),
    ];
    const [row] = layoutText(words).split('\n');
    expect(row).toMatch(/^Policy number +HX-4471 {2,}Renewal date +01\/06\/2027$/);
  });

  it('a gap on the page is a blank line; the left margin is not kept', () => {
    const words = [
      ...line('BRIGHTWATER ENERGY', 300, 100, { line: 1 }),
      ...line('Amount due', 300, 140, { line: 2 }),
      ...line('Questions about your bill', 300, 400, { line: 3 }),
    ];
    expect(layoutText(words)).toBe('BRIGHTWATER ENERGY\nAmount due\n\nQuestions about your bill');
    expect(layoutText([])).toBe('');
  });

  it('measures a crooked page’s slant from its lines', () => {
    const slope = Math.tan((4 * Math.PI) / 180);
    const words = [1, 2, 3, 4].flatMap((n) =>
      line('Your policy schedule begins on the date shown below', 100, n * 120, {
        line: n,
        slope,
      }),
    );
    expect(pageSkew(words)).toBeCloseTo(4, 0);
    expect(
      pageSkew(words.map((w) => ({ ...w, top: w.top - 2 * slope * (w.left - 100) }))),
    ).toBeCloseTo(-4, 0);
    // Too few lines to say: straight.
    expect(pageSkew(words.filter((w) => w.line === 1))).toBe(0);
  });

  it('straightened, a crooked page’s label and value are on one row again', () => {
    const slope = Math.tan((5 * Math.PI) / 180);
    // Four long lines show the slant; then a label far to the left of its value.
    const text = [1, 2, 3].flatMap((n) =>
      line('Please keep this schedule with your policy documents', 100, n * 100, {
        line: n,
        slope,
      }),
    );
    const label = line('Renewal date', 100, 500, { line: 4, block: 1, slope });
    const value = line('01/06/2027', 1500, 500 + slope * 1400, { line: 1, block: 2, slope });
    const words = [...text, ...label, ...value];
    const crooked = layoutText(words, 0);
    expect(crooked).not.toMatch(/Renewal date +01\/06\/2027/);
    const straight = layoutText(words, pageSkew(words));
    expect(straight).toMatch(/Renewal date +01\/06\/2027/);
  });

  it('knows a page read well from one read badly', () => {
    const well = line(
      'Your policy schedule begins on the date shown below and runs for twelve months from then',
      100,
      100,
    );
    expect(readsWell(readingQuality(well))).toBe(true);
    // Upside down, Tesseract reads specks and fragments.
    const garbled = [
      '920z',
      '1dv',
      '$1',
      'Jnoqe',
      'suonsand',
      '9207',
      '|',
      'Aq',
      'anp',
      'Juowkeg',
    ].map((t, i) => word(t, 100 + i * 60, 100, { conf: 30 }));
    expect(readsWell(readingQuality(garbled))).toBe(false);
    // Small letters are read again bigger.
    expect(readsWell(readingQuality(well.map((w) => ({ ...w, height: 14 }))))).toBe(false);
    expect(scaleFor(14)).toBeCloseTo(2.3, 1);
    expect(scaleFor(30)).toBe(1);
    expect(scaleFor(5)).toBe(3);
    expect(scaleFor(0)).toBe(1);
  });

  it('turns a page only when another way up reads far better', () => {
    expect(bestTurn({ 0: 3, 90: 40, 180: 2, 270: 5 })).toBe(90);
    expect(bestTurn({ 0: 1, 90: 0, 180: 25, 270: 2 })).toBe(180);
    // Better, but not twice as good: as it is.
    expect(bestTurn({ 0: 20, 90: 30, 180: 2, 270: 5 })).toBe(0);
    // Too few words to tell by: as it is.
    expect(bestTurn({ 0: 0, 90: 5, 180: 2, 270: 1 })).toBe(0);
  });
});

describe('a page read badly is turned, made bigger and read again (R3)', () => {
  const sentence = 'Your policy schedule begins on the date shown below and runs for twelve months';
  /** Stand-in tools: what each picture reads as, and a note of each call. */
  const tools = (reads: Record<string, OcrWord[] | OcrPage>) => {
    const calls: string[] = [];
    const t: ScanTools = {
      words: async (image) => {
        calls.push(`words ${image}`);
        const read = reads[image] ?? [];
        return Array.isArray(read) ? { words: read, unread: 0 } : read;
      },
      small: async (image, turn, out) => {
        calls.push(`small ${turn} ${out}`);
      },
      prepare: async (image, how, out) => {
        calls.push(
          `prepare ${how.turn} ${how.angle ?? 0} ${how.scale} ${how.clean === true} ${out}`,
        );
      },
    };
    return { t, calls };
  };
  const upright = (height = 30) => line(sentence, 100, 100).map((w) => ({ ...w, height }));
  const garbled = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      word(i % 2 ? 'Jnoqe' : '9z', 100 + i * 60, 100, { conf: 20 }),
    );

  it('a page read well is read once', async () => {
    const { t, calls } = tools({ 'p.png': upright() });
    expect(await readScanPage('p.png', t)).toBe(sentence);
    expect(calls).toEqual(['words p.png']);
  });

  it('a blank page is read once: nothing to judge a turn by', async () => {
    const { t, calls } = tools({ 'p.png': garbled(3) });
    await readScanPage('p.png', t);
    expect(calls).toEqual(['words p.png']);
  });

  it('a page upside down is tried every way up, and read turned', async () => {
    const { t, calls } = tools({
      'p.png': garbled(30),
      'p-turn0.png': garbled(30),
      'p-turn90.png': garbled(10),
      'p-turn180.png': upright(15),
      'p-turn270.png': garbled(10),
      'p-ready.png': upright(),
    });
    expect(await readScanPage('p.png', t)).toBe(sentence);
    expect(calls).toEqual([
      'words p.png',
      'small 0 p-turn0.png',
      'words p-turn0.png',
      'small 90 p-turn90.png',
      'words p-turn90.png',
      'small 180 p-turn180.png',
      'words p-turn180.png',
      'small 270 p-turn270.png',
      'words p-turn270.png',
      // Read unsurely at first: cleaned, and so made twice the size.
      'prepare 180 0 2 true p-ready.png',
      'words p-ready.png',
    ]);
  });

  it('turned, and its letters small, it is made bigger too', async () => {
    const { t, calls } = tools({
      'p.png': garbled(30),
      'p-turn90.png': upright(10),
      'p-ready.png': upright(14),
      'p-ready2.png': upright(30),
    });
    expect(await readScanPage('p.png', t)).toBe(sentence);
    expect(calls.filter((c) => c.startsWith('prepare'))).toEqual([
      'prepare 90 0 2 true p-ready.png',
      'prepare 90 0 2.3 true p-ready2.png',
    ]);
  });

  it('upright with small letters: made bigger, and the better reading kept', async () => {
    const small = upright(14).map((w, i) => (i % 3 ? w : { ...w, conf: 40 }));
    const { t, calls } = tools({ 'p.png': small, 'p-ready.png': upright(32) });
    expect(await readScanPage('p.png', t)).toBe(sentence);
    expect(calls).toEqual([
      'words p.png',
      'prepare 0 0 2.3 false p-ready.png',
      'words p-ready.png',
    ]);
    // Where the second reading is worse, the first is kept.
    const worse = tools({ 'p.png': small, 'p-ready.png': garbled(10) });
    expect(await readScanPage('p.png', worse.t)).toBe(sentence);
  });

  it('a page read well but for a part taken for a picture is evened out and read again', async () => {
    // A phone's shadow over half the page: Tesseract reads the rest well.
    const { t, calls } = tools({
      'p.png': { words: upright(), unread: 0.5 },
      'p-ready.png': upright().concat(line('Payment due by 29 April 2026', 100, 400, { line: 2 })),
    });
    expect(await readScanPage('p.png', t)).toContain('Payment due by 29 April 2026');
    expect(calls).toEqual(['words p.png', 'prepare 0 0 1 false p-ready.png', 'words p-ready.png']);
    // A little of it, a logo say: read once.
    const logo = tools({ 'p.png': { words: upright(), unread: 0.1 } });
    await readScanPage('p.png', logo.t);
    expect(logo.calls).toEqual(['words p.png']);
  });

  it('a page whose lines slant is read again turned back by the slant a small copy shows', async () => {
    const slope = Math.tan((5 * Math.PI) / 180);
    const slanted = [1, 2, 3].flatMap((n) =>
      line('Please keep this schedule with your policy documents safe', 100, n * 100, {
        line: n,
        slope,
      }),
    );
    for (const [measured, angle] of [
      [-5.2, -5.2],
      [0.4, 0],
      [35, 0],
    ] as const) {
      const { t, calls } = tools({ 'p.png': slanted, 'p-ready.png': upright() });
      await readScanPage('p.png', { ...t, skew: async () => measured });
      expect(calls).toEqual([
        'words p.png',
        `prepare 0 ${angle} 1 false p-ready.png`,
        'words p-ready.png',
      ]);
    }
    // A straight page, its long lines saying so, read well: never measured.
    let asked = 0;
    const straightLines = [1, 2, 3].flatMap((n) =>
      line('Please keep this schedule with your policy documents safe', 100, n * 100, { line: n }),
    );
    const straight = tools({ 'p.png': straightLines });
    await readScanPage('p.png', {
      ...straight.t,
      skew: async () => {
        asked += 1;
        return 4;
      },
    });
    expect(asked).toBe(0);
    expect(straight.calls).toEqual(['words p.png']);
  });

  it('a form whose lines are too short to show a slant is measured on a small copy, and laid out by it', async () => {
    // A crooked card: each label well left of its value, the value's row a little lower.
    const slope = Math.tan((5 * Math.PI) / 180);
    const form = [
      ['Passport No', '328006498'],
      ['Surname', 'KHAN'],
      ['Date of issue', '14.06.2023'],
      ['Date of expiry', '14.06.2028'],
    ].flatMap(([label, value], n) => [
      ...line(label as string, 100, 100 + n * 60, { line: 1, block: 2 * n + 1, slope }),
      ...line(value as string, 600, 100 + n * 60 + slope * 500, { line: 1, block: 2 * n + 2 }),
    ]);
    // Read well: laid out by the slant measured, not read again.
    const { t, calls } = tools({ 'p.png': form });
    const asIs = await readScanPage('p.png', { words: t.words });
    expect(asIs).not.toMatch(/Date of expiry +14\.06\.2028/);
    const text = await readScanPage('p.png', { words: t.words, skew: async () => -5 });
    expect(text).toMatch(/Passport No +328006498/);
    expect(text).toMatch(/Date of expiry +14\.06\.2028/);
    expect(calls.filter((c) => c.startsWith('words'))).toEqual(['words p.png', 'words p.png']);
  });

  it('a slant a small copy measured wrongly is not used: the page’s rows say which fits', async () => {
    // A straight statement: labels down the left, values well to the right.
    const rows = [
      ['Statement date', '18 May 2026'],
      ['Card number ending', '3459'],
      ['Previous balance', '£776.70'],
      ['New balance', '£847.14'],
      ['Payment due', '12 June 2026'],
      ['Credit limit', '£4,500.00'],
    ].flatMap(([label, value], n) => [
      ...line(label as string, 100, 100 + n * 40, { line: 1, block: 2 * n + 1 }),
      ...line(value as string, 700, 100 + n * 40, { line: 1, block: 2 * n + 2 }),
    ]);
    // Measured 2.5° out, it would put each value beside the label below it.
    expect(betterSkew(rows, 0, -2.5)).toBe(0);
    const { t } = tools({ 'p.png': rows });
    const text = await readScanPage('p.png', { words: t.words, skew: async () => 2.5 });
    expect(text).toMatch(/Payment due +12 June 2026/);
    expect(text).toMatch(/Statement date +18 May 2026/);
  });

  it('a page of a few words, the rest taken for a picture, is evened out; a blank one is not', async () => {
    const shadowed = tools({
      'p.png': { words: line('Renew online', 100, 100), unread: 0.9 },
      'p-ready.png': upright(),
    });
    expect(await readScanPage('p.png', shadowed.t)).toBe(sentence);
    // Too few words to judge which way up: not turned, only evened out.
    // Next to nothing read: cleaned of speckle, at twice the size, as S5 cleans a grainy page.
    expect(shadowed.calls).toEqual([
      'words p.png',
      'prepare 0 0 2 true p-ready.png',
      'words p-ready.png',
    ]);
    const blank = tools({ 'p.png': { words: [], unread: 0 } });
    await readScanPage('p.png', blank.t);
    expect(blank.calls).toEqual(['words p.png']);
  });

  it('a page read poorly but the right way up is not tried every way up', async () => {
    // A blurred page: half its words read, the rest fragments.
    const blurred = upright(30).flatMap((w, i) => [
      w,
      word(i % 2 ? 'tbe' : 'cf', w.left, 200, { conf: 40 }),
    ]);
    const { t, calls } = tools({ 'p.png': blurred, 'p-ready.png': upright() });
    await readScanPage('p.png', t);
    expect(calls.some((c) => c.startsWith('small'))).toBe(false);
  });

  it('a page on its side, which Tesseract reads in columns, is turned a quarter the way it reads', async () => {
    // Read surely, a line at a time turned: but each word stands taller than wide.
    const onItsSide = upright().map((w, i) => ({
      ...w,
      left: 100,
      top: 100 + i * 120,
      width: 30,
      height: w.width,
    }));
    const { t, calls } = tools({
      'p.png': onItsSide,
      'p-turn0.png': onItsSide,
      'p-turn90.png': garbled(20),
      'p-turn270.png': upright(15),
      'p-ready.png': upright(),
    });
    expect(await readScanPage('p.png', t)).toBe(sentence);
    expect(calls.filter((c) => c.startsWith('prepare'))).toEqual([
      'prepare 270 0 1 false p-ready.png',
    ]);
    expect(bestTurn({ 0: 40, 90: 12, 180: 0, 270: 3 }, true)).toBe(90);
    expect(bestTurn({ 0: 40, 90: 2, 180: 0, 270: 3 }, true)).toBe(0);
    expect(readingQuality(onItsSide).tall).toBeGreaterThan(SIDEWAYS_ABOVE);
    expect(readingQuality(upright()).tall).toBe(0);
  });

  it('the page as it came is kept unless the second look reads clearly more', async () => {
    const first = upright(14);
    const other = (extra: number) =>
      line(
        `Your polcy schedule begins on the date shown below and runs for twelve months${' and then'.repeat(extra)}`,
        100,
        100,
      );
    // One word more that looks like one: the first stands.
    const near = tools({ 'p.png': first, 'p-ready.png': other(0).concat(word('more', 1900, 100)) });
    expect(await readScanPage('p.png', near.t)).toBe(sentence);
    // Three more: the second look is kept.
    const far = tools({ 'p.png': first, 'p-ready.png': other(2) });
    expect(await readScanPage('p.png', far.t)).toMatch(/and then and then$/);
    expect(REREAD_MARGIN).toBe(3);
  });

  it('a second look whose step fails leaves the first reading, whichever step it is (the R3 review)', async () => {
    const small = upright(14).map((w, i) => (i % 3 ? w : { ...w, conf: 40 }));
    const failed = () => Promise.reject(new Error('magick: cache resources exhausted'));
    // ImageMagick refusing to prepare the page.
    const noPrepare = tools({ 'p.png': small, 'p-ready.png': upright(32) });
    expect(await readScanPage('p.png', { ...noPrepare.t, prepare: failed })).toBe(sentence);
    // Tesseract failing on the page made ready.
    const noRead = tools({ 'p.png': small });
    const words = noRead.t.words;
    expect(
      await readScanPage('p.png', {
        ...noRead.t,
        words: (image, signal) => (image === 'p.png' ? words(image, signal) : failed()),
      }),
    ).toBe(sentence);
    // The small copies, and the slant, failing too.
    const upside = tools({ 'p.png': garbled(30) });
    const text = await readScanPage('p.png', { ...upside.t, small: failed, skew: failed });
    expect(text).toContain('Jnoqe');
    // But a read told to stop stops.
    const stop = new AbortController();
    await expect(
      readScanPage(
        'p.png',
        {
          ...noPrepare.t,
          prepare: async () => {
            stop.abort();
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          },
        },
        stop.signal,
      ),
    ).rejects.toThrow();
  });

  it('the whole second look has one budget: past it, the best reading so far stands (the R3 review)', async () => {
    const small = upright(14).map((w, i) => (i % 3 ? w : { ...w, conf: 40 }));
    const { t } = tools({ 'p.png': small, 'p-ready.png': upright(32) });
    // A step that only ends when its budget does, and one that never ends at all.
    const waits = (_i: string, _h: Preparation, _o: string, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason as Error));
      });
    const never = () => new Promise<void>(() => undefined);
    for (const prepare of [waits, never]) {
      const started = Date.now();
      expect(await readScanPage('p.png', { ...t, prepare }, undefined, { budgetMs: 200 })).toBe(
        sentence,
      );
      expect(Date.now() - started).toBeLessThan(3_000);
    }
    // One budget for every step: four small copies each taking most of it run past it.
    let made = 0;
    const slow = tools({ 'p.png': garbled(30) });
    const started = Date.now();
    await readScanPage(
      'p.png',
      {
        ...slow.t,
        small: async () => {
          made += 1;
          await new Promise((r) => setTimeout(r, 120));
        },
      },
      undefined,
      { budgetMs: 200 },
    );
    expect(made).toBeLessThan(4);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(SECOND_LOOK_MS).toBe(45_000);
  });

  it('a page that is itself a second look is read once', async () => {
    const { t, calls } = tools({ 'p.png': garbled(30) });
    await readScanPage('p.png', t, undefined, { once: true });
    expect(calls).toEqual(['words p.png']);
  });

  it('second looks end when told: a page after is read once, and one under way ends with its best reading (the R3 re-check)', async () => {
    const small = upright(14).map((w, i) => (i % 3 ? w : { ...w, conf: 40 }));
    const { t, calls } = tools({ 'p.png': small, 'p-ready.png': upright(32) });
    await readScanPage('p.png', t, undefined, { until: AbortSignal.abort() });
    expect(calls).toEqual(['words p.png']);
    // Under way: a step that waits on its signal ends when `until` does,
    // not at the budget's 45 seconds.
    const until = new AbortController();
    const waits = (_i: string, _h: Preparation, _o: string, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason as Error));
      });
    setTimeout(() => until.abort(), 100);
    const started = Date.now();
    expect(
      await readScanPage('p.png', { ...t, prepare: waits }, undefined, { until: until.signal }),
    ).toBe(sentence);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('says when its second look has read a cleaned copy, so S5 need not clean it again (the R3 re-check)', async () => {
    let cleaned = 0;
    const onCleaned = () => {
      cleaned += 1;
    };
    const shadowed = tools({
      'p.png': { words: line('Renew online', 100, 100), unread: 0.9 },
      'p-ready.png': upright(),
    });
    await readScanPage('p.png', shadowed.t, undefined, { onCleaned });
    expect(shadowed.calls).toContain('prepare 0 0 2 true p-ready.png');
    expect(cleaned).toBe(1);
    // Made bigger, not cleaned: not said.
    const small = upright(14).map((w, i) => (i % 3 ? w : { ...w, conf: 40 }));
    const bigger = tools({ 'p.png': small, 'p-ready.png': upright(32) });
    await readScanPage('p.png', bigger.t, undefined, { onCleaned });
    expect(bigger.calls).toContain('prepare 0 0 2.3 false p-ready.png');
    expect(cleaned).toBe(1);
  });

  it('a big page is never made ready past PREPARE_MAX_PIXELS (the R3 review)', async () => {
    // A phone's 4000 by 3000 photo, read unsurely: it would be cleaned at twice its size.
    const unsure = upright(14).map((w) => ({ ...w, conf: 50 }));
    const { t, calls } = tools({
      'p.png': { words: unsure, unread: 0, width: 4000, height: 3000 },
    });
    await readScanPage('p.png', t);
    const prepared = calls.find((c) => c.startsWith('prepare')) as string;
    const scale = Number(prepared.split(' ')[3]);
    expect(4000 * scale * 3000 * scale).toBeLessThanOrEqual(PREPARE_MAX_PIXELS);
    expect(scale).toBe(1.4);
    // A page as drawn from a PDF still made twice its size.
    expect(cappedScale(2, 1240, 1754)).toBe(2);
    // Never made smaller, whatever its size.
    expect(cappedScale(2, 9000, 9000)).toBe(1);
  });

  it('which way up, from Tesseract’s orientation model where there is one; else each way up tried', async () => {
    const sure = tools({ 'p.png': garbled(30), 'p-ready.png': upright() });
    const asked: string[] = [];
    expect(
      await readScanPage('p.png', {
        ...sure.t,
        orient: async (image) => {
          asked.push(image);
          return { turn: 180, confidence: 9 };
        },
      }),
    ).toBe(sentence);
    expect(asked).toEqual(['p.png']);
    expect(sure.calls.filter((c) => c.startsWith('small'))).toEqual([]);
    expect(sure.calls.filter((c) => c.startsWith('prepare'))).toEqual([
      'prepare 180 0 2 true p-ready.png',
    ]);
    // Unsure, or not to be had: each way up on a small copy, as without it.
    for (const orient of [
      async () => ({ turn: 90 as const, confidence: 0.4 }),
      async () => null,
      () => Promise.reject(new Error('no osd')),
    ]) {
      const unsure = tools({
        'p.png': garbled(30),
        'p-turn180.png': upright(15),
        'p-ready.png': upright(),
      });
      await readScanPage('p.png', { ...unsure.t, orient });
      expect(unsure.calls.filter((c) => c.startsWith('small'))).toHaveLength(4);
      expect(unsure.calls.filter((c) => c.startsWith('prepare'))[0]).toMatch(/^prepare 180 /);
    }
    expect(OSD_MIN_CONFIDENCE).toBe(2);
    // A page on its side said to be upright: tried each way up after all.
    const onItsSide = upright().map((w, i) => ({
      ...w,
      left: 100,
      top: 100 + i * 120,
      width: 30,
      height: w.width,
    }));
    const side = tools({
      'p.png': onItsSide,
      'p-turn270.png': upright(15),
      'p-ready.png': upright(),
    });
    await readScanPage('p.png', { ...side.t, orient: async () => ({ turn: 0, confidence: 9 }) });
    expect(side.calls.filter((c) => c.startsWith('small'))).toHaveLength(4);
    expect(side.calls.filter((c) => c.startsWith('prepare'))[0]).toMatch(/^prepare 270 /);
  });

  it('a sparse two-column form a little crooked never pairs a label with the next row’s value (the R3 review)', async () => {
    // Labels far left, values far right, rows 40 pixels apart; 1.2° off.
    const slope = Math.tan((1.2 * Math.PI) / 180);
    const rows = [
      ['Start date', '6 January 2025'],
      ['End date', '5 January 2027'],
      ['Notice period', 'one month'],
    ];
    const form = rows.flatMap(([label, value], n) => [
      ...line(label as string, 100, 100 + n * 40, { line: 1, block: 2 * n + 1, slope }),
      ...line(value as string, 1500, 100 + n * 40 + slope * 1400, {
        line: 1,
        block: 2 * n + 2,
        slope,
      }),
    ]);
    const asIs = layoutText(form, 0);
    expect(asIs).not.toMatch(/End date +6 January 2025/);
    expect(asIs).not.toMatch(/Notice period +5 January 2027/);
    // A small copy's measure of under a degree is weighed against the rows, and fits.
    expect(betterSkew(form, 0, 1.2)).toBe(1.2);
    expect(MIN_LAYOUT_SKEW).toBe(0.3);
    // Under a degree off: too little to read the page again, enough to part
    // a row; a small copy's measure of it lays the rows out (the R3 review).
    const slight = Math.tan((0.6 * Math.PI) / 180);
    const slightForm = rows.flatMap(([label, value], n) => [
      ...line(label as string, 100, 100 + n * 40, { line: 1, block: 2 * n + 1, slope: slight }),
      ...line(value as string, 1500, 100 + n * 40 + slight * 1400, {
        line: 1,
        block: 2 * n + 2,
        slope: slight,
      }),
    ]);
    const { t } = tools({ 'p.png': slightForm });
    const read = await readScanPage('p.png', { words: t.words, skew: async () => -0.6 });
    expect(read).toMatch(/End date +5 January 2027/);
    expect(read).toMatch(/Start date +6 January 2025/);
  });

  it('a crafted table of thousands of lines at one height is laid out in good time (the R3 review)', () => {
    const many = Array.from({ length: 20_000 }, (_, i) =>
      word('cell', 100 + i * 50, 100, { block: i + 1, line: 1 }),
    );
    const started = Date.now();
    const text = layoutText(many);
    rowFit(many, 0.5);
    expect(Date.now() - started).toBeLessThan(5_000);
    // No row holds more than MAX_LINES_A_ROW of them.
    expect(Math.max(...text.split('\n').map((l) => (l.match(/cell/g) ?? []).length))).toBe(
      MAX_LINES_A_ROW,
    );
  });

  it('without ImageMagick, a page is read once, laid out', async () => {
    const { t, calls } = tools({ 'p.png': garbled(30) });
    await readScanPage('p.png', { words: t.words });
    expect(calls).toEqual(['words p.png']);
  });

  it('stops when its read is told to stop', async () => {
    const { t } = tools({ 'p.png': garbled(30) });
    const stop = new AbortController();
    stop.abort();
    await expect(readScanPage('p.png', t, stop.signal)).rejects.toThrow();
  });
});
