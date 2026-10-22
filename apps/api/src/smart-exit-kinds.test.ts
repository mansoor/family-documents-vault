import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { proposeWithTie, type ProposalKind } from '@fdv/shared';
import { FIXTURE_KINDS, readerBeforeC1 } from '@fdv/shared/testdata';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The kinds C1 adds (0.9.0, 0077: pay statements and investment
 * statements) change nothing the Smart exit measured (0.8.0, S5,
 * docs/smart-exit.md): on every paper of both corpora — the first 200 and
 * the 115 held out — the reader proposes exactly what the reader before C1
 * proposed (develop e9bd5b4, frozen as @fdv/shared/testdata's
 * readerBeforeC1) with the kinds before 0077. So the recorded
 * numbers stand without the hour's run in a container (FDV_SMART_EXIT=1):
 * nothing a card is scored on can have moved.
 *
 * The papers' words are taken from the corpus's own generator as it lays
 * each page out (scripts/smart-corpus.mjs), line by line, before any PDF is
 * drawn: a text PDF's words exactly, and a scan's words before OCR reads
 * them. Every paper is drawn as text here (only how it would be drawn
 * changes: its words come first, from its own random numbers).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NEW_KINDS = ['pay_statement', 'investment_statement'];

interface PageLike {
  items: Array<{ x: number; y: number; text: string }>;
}
interface Template {
  kind: string | null;
  scanned: number;
  make: (...args: unknown[]) => { pages: PageLike[] };
}
interface Paper {
  name: string;
  kind: string | null;
  text: string;
}

/** A page's words as pdftotext gives them: a line for each baseline, left to right. */
function textOf(pages: PageLike[]): string {
  return pages
    .map((page) => {
      const lines = new Map<number, Array<{ x: number; text: string }>>();
      for (const it of page.items) {
        const y = Math.round(it.y);
        lines.set(y, [...(lines.get(y) ?? []), { x: it.x, text: it.text }]);
      }
      return [...lines.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, items]) =>
          items
            .sort((a, b) => a.x - b.x)
            .map((i) => i.text)
            .join('   '),
        )
        .join('\n');
    })
    .join('\n\f\n');
}

async function papers(): Promise<{ papers: Paper[]; people: string[] }> {
  const at = (f: string) => pathToFileURL(path.join(ROOT, 'scripts', f)).href;
  const corpus = (await import(/* @vite-ignore */ at('smart-corpus.mjs'))) as {
    smartCorpus: (o: { seed: number; corpus: 'first' | 'second' }) => unknown;
    corpusPeople: () => Array<{ name: string }>;
  };
  const first = (await import(/* @vite-ignore */ at('smart-corpus-papers.mjs'))) as {
    PAPERS: Record<string, Template>;
  };
  const second = (await import(/* @vite-ignore */ at('smart-corpus-papers-2.mjs'))) as {
    PAPERS_2: Record<string, Template>;
  };
  const out: Paper[] = [];
  const kept: Array<() => void> = [];
  for (const set of [first.PAPERS, second.PAPERS_2]) {
    for (const [name, tpl] of Object.entries(set)) {
      const { make, scanned } = tpl;
      kept.push(() => {
        tpl.make = make;
        tpl.scanned = scanned;
      });
      tpl.scanned = 0;
      tpl.make = (...args: unknown[]) => {
        const made = make(...args);
        out.push({ name, kind: tpl.kind, text: textOf(made.pages) });
        return made;
      };
    }
  }
  try {
    for (const [seed, which] of [
      [1, 'first'],
      [2, 'second'],
    ] as const) {
      const made = out.length;
      try {
        corpus.smartCorpus({ seed, corpus: which });
      } catch {
        // Every paper is made before the corpus picks a scan to copy, which
        // a corpus drawn all as text has none of: what was made is all here.
      }
      expect(out.length).toBeGreaterThan(made + 100);
    }
  } finally {
    for (const undo of kept) undo();
  }
  return { papers: out, people: corpus.corpusPeople().map((p) => p.name) };
}

describe('the kinds C1 adds and the Smart exit (0077)', () => {
  let all: Paper[] = [];
  let people: string[] = [];
  beforeAll(async () => {
    ({ papers: all, people } = await papers());
  }, 120_000);

  it('reads every paper of both corpora', () => {
    // 200 and 115, less the blank pages and the copies, which are no paper's.
    expect(all.length).toBeGreaterThanOrEqual(300);
    expect(new Set(all.map((p) => p.kind)).size).toBeGreaterThanOrEqual(20);
  });

  it('proposes on every paper exactly what the reader before C1 proposed', () => {
    const family = people.map((name, i) => ({ id: `m-${i}`, name }));
    // The household's kinds before 0077, read by the reader before C1
    // (develop e9bd5b4, frozen in @fdv/shared/testdata) …
    const before: ProposalKind[] = FIXTURE_KINDS.filter((k) => !NEW_KINDS.includes(k.key)).map(
      (k) => (k.key === 'bank_statement' ? { ...k, label: 'Bank / investment statement' } : k),
    );
    // … and as 0077 leaves them, the two new ones among them, read by today's.
    const after: ProposalKind[] = FIXTURE_KINDS.map((k) =>
      k.key === 'bank_statement' ? { ...k, label: 'Bank statement' } : k,
    );
    expect(after.filter((k) => NEW_KINDS.includes(k.key))).toHaveLength(2);
    const dump: Array<{ name: string; kind: string | null; proposal: unknown }> = [];
    for (const paper of all) {
      const was = readerBeforeC1.proposeWithTie(paper.text, {
        types: before,
        people: family,
        dateOrder: 'dmy',
      });
      const now = proposeWithTie(paper.text, { types: after, people: family, dateOrder: 'dmy' });
      expect({ paper: paper.name, ...now }).toEqual({ paper: paper.name, ...was });
      // Neither new kind is offered for a paper of the corpus.
      expect(NEW_KINDS).not.toContain(now.proposal.type_key?.value);
      dump.push({ name: paper.name, kind: paper.kind, proposal: now });
    }
    // For comparing the reader at two commits by hand (the C1 report).
    if (process.env.FDV_SMART_KINDS_OUT) {
      writeFileSync(process.env.FDV_SMART_KINDS_OUT, JSON.stringify(dump, null, 1));
    }
  });
});
