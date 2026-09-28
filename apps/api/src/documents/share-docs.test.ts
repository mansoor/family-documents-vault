import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What a client is told a share link's routes can answer (the 5.20 review,
 * M520-06): every error code shares.ts answers with is in the API
 * changelog, and every one POST /shared/code answers with is in the
 * client's own word on sendLinkCode — a phone is written against those two,
 * not against this code.
 */
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe('the share routes, as their clients are told', () => {
  it('every error code the share routes answer with is in the API changelog', async () => {
    const source = await readFile(at('./shares.ts'), 'utf8');
    const changelog = await readFile(at('../../../../docs/api-changelog.md'), 'utf8');
    const codes = new Set(
      [...source.matchAll(/new ApiError\(\s*\d{3},\s*'([a-z_]+)'/g)].map((m) => m[1] ?? ''),
    );
    expect(codes).toContain('code_not_sent');
    for (const code of codes) expect(changelog, code).toContain(code);
  });

  it("sendLinkCode's word names every answer POST /shared/code gives but 200", async () => {
    const client = await readFile(at('../../../../packages/client/src/api.ts'), 'utf8');
    const said = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*sendLinkCode:/.exec(client)?.[1] ?? '';
    for (const code of [
      'code_limit',
      'email_code_unavailable',
      'code_not_sent',
      'other_device',
      'no_code_needed',
    ]) {
      expect(said, code).toContain(code);
    }
  });
});
