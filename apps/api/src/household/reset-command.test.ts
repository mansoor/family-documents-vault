import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resetCommand } from '@fdv/shared';

/**
 * The command an owner is shown for whoever runs the server (5.29, the
 * review's F529-08 and W529-1): the address goes into a shell, so it is
 * quoted, and a quote in it can never make it another address.
 */

/** A POSIX shell here, to parse the command as an operator's would. */
const sh = spawnSync('sh', ['-c', 'true']).status === 0;

/** The words a shell makes of the command: the eighth is the address. */
const asParsed = (command: string) =>
  execFileSync('sh', ['-c', `set -- ${command}; printf '%s\\n' "$#" "$8"`], {
    encoding: 'utf8',
  }).split('\n');

describe('the reset command', () => {
  it('quotes the address for a POSIX shell, each quote written as quote, backslash, quote, quote', () => {
    expect(resetCommand('sam@example.com')).toBe(
      "docker compose exec api node apps/api/dist/cli.mjs reset-password 'sam@example.com'",
    );
    expect(resetCommand("a'nn'e@example.com")).toBe(
      "docker compose exec api node apps/api/dist/cli.mjs reset-password 'a'\\''nn'\\''e@example.com'",
    );
  });

  it.skipIf(!sh)(
    'a shell passes the address whole and as it is: a quote, a dollar and a space',
    () => {
      for (const address of [
        "o'brien@example.com",
        "a'nn'e@example.com",
        "it's $HOME and more@example.com",
        'plain@example.com',
      ]) {
        const [count, parsed] = asParsed(resetCommand(address));
        expect(count, address).toBe('8');
        expect(parsed, address).toBe(address);
      }
    },
  );
});
