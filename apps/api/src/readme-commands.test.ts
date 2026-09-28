import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The README's commands as a family runs them (ROT-O-06): the command that
 * makes a new master key once failed in Windows PowerShell, which strips
 * the double quotes inside a single-quoted argument. Run in the shell this
 * machine has: PowerShell on Windows, sh elsewhere.
 */

const README = new URL('../../../README.md', import.meta.url);

/** The one-line command in the first ```bash block after a heading. */
async function firstCommand(heading: string): Promise<string> {
  const text = (await readFile(README, 'utf8')).replace(/\r\n/g, '\n');
  const at = text.indexOf(`\n${heading}\n`);
  expect(at).toBeGreaterThan(0);
  const block = /```bash\n([^\n]+)\n```/.exec(text.slice(at));
  return block?.[1] ?? '';
}

function inShell(command: string): string {
  return process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
      })
    : execFileSync('sh', ['-c', command], { encoding: 'utf8' });
}

describe("the README's commands", () => {
  it('the one that makes a new master key makes one, in this shell', async () => {
    const command = await firstCommand('### Rotating the master key');
    expect(command).toMatch(/^node /);
    expect(inShell(command).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, 30_000);
});
