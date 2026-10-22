import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  learnedIssuerKey,
  readPaper,
  shapeLessonOf,
  shapeSealed,
  SHAPE_WORDS,
  teachShape,
  type ProposalContext,
  type ShapeFiled,
} from '@fdv/shared';
import { FIXTURE_KINDS } from '@fdv/shared/testdata';
import { describe, expect, it } from 'vitest';

/**
 * The shape's privacy (0.9.0, R1), on the Smart exit's corpora
 * (scripts/smart-corpus.mjs): every text paper of both sets, and the first
 * again for a family whose names are everyday words, read as a shape — and
 * each again with the household's names, numbers, address and amounts put
 * where labels and headings are. No name, number, address or amount of the
 * household's is ever part of a shape, nor of what a store keeps of one.
 */

const day = (date: string) => ({ date, precision: 'day' as const });
const keepsAll = { issued: true, expires: true, identifier: true };
let n = 0;
const newId = () => `shape-${(n += 1)}`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
interface CorpusPerson {
  key: string;
  name: string;
  first: string;
  middle?: string;
  surname: string;
  birthplace: string;
  ni?: string;
  nhs: string;
}
interface Corpus {
  household: { name: string; people: Array<{ key: string; name: string }> };
  files: Array<{
    path: string;
    bytes: Buffer;
    entry: {
      mode: string;
      truth: {
        kind: string | null;
        number: string | null;
        issuer: string | null;
        issued: string | null;
        expires: string | null;
      };
    };
  }>;
}

/**
 * A text PDF of the corpus's, set out as pdftotext -layout would: each
 * line's words at their place. Only the corpus's own PDFs, which write
 * each piece of text as one `Tm … Tj`.
 */
function laidOut(pdf: Buffer): string {
  const s = pdf.toString('latin1');
  const pages: string[] = [];
  for (const stream of s.split('endstream')) {
    const items: Array<{ x: number; y: number; t: string }> = [];
    for (const m of stream.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm \(((?:\\.|[^\\)])*)\) Tj/g)) {
      const t = (m[3] as string)
        .replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\(.)/g, '$1');
      items.push({ x: Number(m[1]), y: Math.round(Number(m[2])), t });
    }
    if (items.length === 0) continue;
    const ys = [...new Set(items.map((i) => i.y))].sort((a, b) => b - a);
    pages.push(
      ys
        .map((y) => {
          let line = '';
          for (const it of items.filter((i) => i.y === y).sort((a, b) => a.x - b.x)) {
            const col = Math.max(0, Math.round((it.x - 40) / 5));
            line = line.length >= col ? `${line}   ${it.t}` : `${line.padEnd(col)}${it.t}`;
          }
          return line;
        })
        .join('\n'),
    );
  }
  return pages.join('\n\n');
}

/** A seeded random number from 0 to 1 (mulberry32). */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Other people's first names and surnames, the common sort — those that are
 * also everyday words among them (the R1 review, P2): none is in the list.
 */
const THIRD_PARTY = [
  'Will',
  'Cash',
  'Kit',
  'Charity',
  'Gross',
  'Bank',
  'Bill',
  'Grant',
  'Mark',
  'Price',
  'Page',
  'Law',
  'Rose',
  'Hope',
  'Faith',
  'Grace',
  'Joy',
  'Read',
  'Swift',
  'Best',
  'Long',
  'Day',
  'Hand',
  'Head',
  'Key',
  'Hart',
  'Lane',
  'King',
  'Young',
  'Wood',
  'Hill',
  'Green',
  'White',
  'Brown',
  'Black',
  'Smith',
  'Jones',
  'Taylor',
  'Patel',
  'Singh',
  'Chen',
  'Garcia',
  'Murphy',
  'James',
  'John',
  'Mary',
  'Emma',
  'Noah',
  'Mia',
  'Jack',
  'Harry',
  'Amelia',
  'Sophie',
  'Daniel',
  'Priya',
  'Fatima',
  'Mohammed',
  'Nadia',
  'Robert',
  'Sean',
  'Lucy',
];

describe('the shape’s privacy, on the corpus (R1)', () => {
  it('no common first name or surname is a word a shape keeps', () => {
    expect(THIRD_PARTY.filter((n) => SHAPE_WORDS.has(n.toLowerCase()))).toEqual([]);
  });

  it('no name, number, address or amount of the household’s ever reaches a shape, however it is written', async () => {
    const { smartCorpus, corpusPeople } = (await import(
      /* @vite-ignore */ pathToFileURL(path.join(ROOT, 'scripts/smart-corpus.mjs')).href
    )) as {
      smartCorpus: (o: {
        seed: number;
        corpus?: string;
        owner?: string;
        surname?: string;
      }) => Corpus;
      corpusPeople: (o: { owner?: string; surname?: string }) => CorpusPerson[];
    };
    // The two corpora: the second as it is, and the first for a family whose
    // names are everyday words (its layouts and numbers are the same).
    const runs: Array<Corpus & { family: CorpusPerson[] }> = [
      { ...smartCorpus({ seed: 2, corpus: 'second' }), family: corpusPeople({}) },
      {
        ...smartCorpus({ seed: 1, owner: 'Grace', surname: 'Bill' }),
        family: corpusPeople({ owner: 'Grace', surname: 'Bill' }),
      },
    ];
    const rnd = random(541);
    let papers = 0;
    let fuzzed = 0;
    for (const corpus of runs) {
      const people = corpus.family;
      const pctx: ProposalContext = {
        types: FIXTURE_KINDS,
        people: people.map((p) => ({ id: p.key, name: p.name })),
        household: corpus.household.name,
        dateOrder: 'dmy',
      };
      // The household's own: its people's names, where they were born, its
      // address, and their numbers.
      const secrets = new Set<string>();
      const numbers: string[] = [];
      for (const p of people) {
        for (const w of [p.first, p.middle, p.surname, p.name, p.birthplace]) {
          for (const x of (w ?? '').toLowerCase().split(/[^a-z]+/))
            if (x.length >= 2) secrets.add(x);
        }
        for (const num of [p.ni, p.nhs]) if (num) numbers.push(num);
      }
      for (const w of ['elm', 'ashby', 'vale', 'av4', '7qt']) secrets.add(w);
      // Other people's names, split as OCR splits them, and a US address
      // (the R1 review, P2): none is ever a word of a shape either.
      for (const name of THIRD_PARTY) secrets.add(name.toLowerCase());
      for (const w of ['ivia', 'hmed', 'maple', 'avenue', 'springfield']) secrets.add(w);
      const forbidden = (where: string, words: readonly string[]) => {
        for (const w of words) {
          expect(SHAPE_WORDS.has(w), `${where}: ${w}`).toBe(true);
          expect(secrets.has(w), `${where}: ${w}`).toBe(false);
          expect(w, where).not.toMatch(/\d/);
        }
      };
      const check = (where: string, text: string, filed: ShapeFiled, issuer: string) => {
        const paper = readPaper(text, pctx);
        forbidden(`${where} words`, paper.words);
        for (const d of [...paper.dates, ...paper.numbers])
          forbidden(`${where} label`, d.label.split(' '));
        // And what a store keeps of it, once taught.
        const lesson = shapeLessonOf({
          paper,
          filed,
          issuer,
          role: 'owner',
          keeps: keepsAll,
          reviewed: true,
          vouched: true,
        });
        if (!lesson) return;
        const kept = teachShape([], lesson, { newId, today: '2026-10-01' }).shapes;
        for (const s of kept) {
          const json = JSON.stringify(shapeSealed(s));
          for (const num of [...numbers, filed.identifier ?? '']) {
            if (num.replace(/\s/g, '').length >= 4) {
              expect(json.replace(/\s/g, ''), where).not.toContain(num.replace(/\s/g, ''));
            }
          }
          forbidden(`${where} kept`, s.words);
          for (const l of s.lessons) {
            if (l.field !== 'type_key' && l.field !== 'owner_member_id') {
              forbidden(`${where} lesson`, l.value.split(' '));
            }
          }
        }
      };
      const pieces = [
        ...people.flatMap((p) => [
          p.name,
          `${p.first} ${p.surname}`,
          p.surname.toUpperCase(),
          p.birthplace,
        ]),
        ...numbers,
        '14 Elm Street',
        'Ashby Vale',
        'AV4 7QT',
        '£1,234.56',
        '41228706',
        '30-91-57',
        ...THIRD_PARTY.map(
          (n, i) =>
            `${['Dr', 'Mr', 'Ms', 'Mrs'][i % 4]} ${n} ${THIRD_PARTY[(i * 7) % THIRD_PARTY.length]}`,
        ),
        `${people[0]?.first.slice(0, 2)} ${people[0]?.first.slice(2)}`,
        `${people[1]?.first.slice(0, 1)} ${people[1]?.first.slice(1)}`,
        '1420 Maple Avenue',
        'Springfield, IL 62704',
      ];
      for (const f of corpus.files) {
        if (f.entry.mode !== 'text') continue;
        const text = laidOut(f.bytes);
        const t = f.entry.truth;
        const filed: ShapeFiled = {
          type_key: t.kind,
          owner_member_id: null,
          issued: t.issued ? day(t.issued) : null,
          expires: t.expires ? day(t.expires) : null,
          identifier: t.number,
          issued_by: t.issuer,
        };
        const issuer = learnedIssuerKey(t.issuer) || 'nobody';
        check(f.path, text, filed, issuer);
        papers += 1;
        // Fuzzed: the household's names, numbers, address and amounts put
        // where labels and headings are — before a date, on a line of their
        // own, in a column of their own.
        const lines = text.split('\n');
        for (let i = 0; i < 3; i += 1) {
          const at = Math.floor(rnd() * lines.length);
          const piece = pieces[Math.floor(rnd() * pieces.length)] as string;
          const how = Math.floor(rnd() * 3);
          const line = lines[at] ?? '';
          lines[at] =
            how === 0
              ? `${piece} ${line}`
              : how === 1
                ? `${piece}\n${line}`
                : `${line}     ${piece}`;
        }
        check(`${f.path} (fuzzed)`, lines.join('\n'), filed, issuer);
        fuzzed += 1;
      }
    }
    expect(papers).toBeGreaterThan(180);
    expect(fuzzed).toBe(papers);
  }, 180_000);
});
