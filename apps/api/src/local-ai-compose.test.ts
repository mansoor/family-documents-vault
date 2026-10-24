import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The compose file's optional local AI (0.9.0, R4; the review, L8): the
 * `ollama` service is on a network of its own, `local-ai`, which the worker
 * alone shares — the API, the web and the database never reach it — and it
 * publishes no port. Read as text, block by block, as the file is written.
 */

const COMPOSE = new URL('../../../docker-compose.yml', import.meta.url);

/** One top-level service's block: its lines, up to the next service or section. */
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

describe('the local AI in docker-compose.yml (R4, L8)', () => {
  it('is on the local-ai network alone, with the worker, and publishes nothing', async () => {
    const text = await readFile(COMPOSE, 'utf8');
    const ollama = block(text, 'ollama');
    expect(ollama).toMatch(/profiles: \[local-ai\]/);
    expect(ollama).toMatch(/networks:\n\s+- local-ai\n/);
    expect(ollama).not.toMatch(/- default/);
    expect(ollama).not.toMatch(/ports:/);
    const worker = block(text, 'worker');
    expect(worker).toMatch(/networks:\n\s+- default\n\s+- local-ai/);
    for (const other of ['api', 'web', 'postgres']) {
      expect(block(text, other), other).not.toMatch(/local-ai/);
    }
    expect(text).toMatch(/\nnetworks:\n(?:\s+#.*\n)*\s+local-ai:/);
  });
});
