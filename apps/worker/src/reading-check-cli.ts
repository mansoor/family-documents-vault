import { numbersOnly, READING_CHECK_N, type ReadingCheckSummary } from '@fdv/shared';

/**
 * `node apps/worker/dist/cli.mjs reading-check --household <id> [--n 50]`
 * (0.9.0, R0): the Reading check's numbers for one household, printed as
 * JSON, for comparing one release's reader with another's on a test vault.
 *
 * It runs as the vault itself, so it reads no Only me document, anybody's,
 * and no learned rules — the general reader alone, as its note on standard
 * error says — and what it prints is held to numbers only: the summary
 * passes `numbersOnly` or nothing is printed, nothing else is ever written
 * to standard output, the reading's own log goes nowhere, and a failure is
 * said in words of its own, never with an error's message (which could
 * carry a value). Nothing is kept: no check row, no misses.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the CLI's summary leaves out, said with it (the owner's decision, R0 review). */
export const READING_CHECK_CLI_NOTE =
  'Only me documents are not included, and no learned rules are used: the general reader alone.';

export const READING_CHECK_USAGE =
  'usage: cli.mjs reading-check --household <household id> [--n <10-500, default 50>]';

/** The command's words, read: the household and N, or why not. */
export function readingCheckArgs(
  args: readonly string[],
): { household: string; n: number } | { error: string } {
  let household: string | null = null;
  let n: number = READING_CHECK_N.default;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === '--household' && v !== undefined) {
      household = v;
      i++;
    } else if (a === '--n' && v !== undefined) {
      if (!/^\d+$/.test(v)) return { error: '--n must be a whole number from 10 to 500' };
      n = Number(v);
      i++;
    } else {
      return { error: READING_CHECK_USAGE };
    }
  }
  if (!household || !UUID.test(household)) return { error: READING_CHECK_USAGE };
  if (n < READING_CHECK_N.min || n > READING_CHECK_N.max) {
    return { error: '--n must be a whole number from 10 to 500' };
  }
  return { household, n };
}

/** Where the command writes: standard output takes the numbers alone. */
export interface CommandOut {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * The command: the numbers printed, or a refusal in its own words. Answers
 * the exit code: 0, 1 when it could not run, 2 for the wrong words.
 */
export async function readingCheckCommand(
  args: readonly string[],
  run: (household: string, n: number) => Promise<ReadingCheckSummary>,
  out: CommandOut,
): Promise<number> {
  const parsed = readingCheckArgs(args);
  if ('error' in parsed) {
    out.stderr(parsed.error);
    return 2;
  }
  let summary: ReadingCheckSummary;
  try {
    summary = await run(parsed.household, parsed.n);
  } catch {
    out.stderr(
      'The reading check could not run. Check that the household id is right, that it has an ' +
        'owner, and that the database and the vault’s files can be reached.',
    );
    return 1;
  }
  if (!numbersOnly(summary)) {
    out.stderr('The reading check’s summary was not numbers only, so nothing was printed.');
    return 1;
  }
  // Said beside the numbers, never in them: standard output stays numbers only.
  out.stderr(READING_CHECK_CLI_NOTE);
  out.stdout(JSON.stringify(summary, null, 2));
  return 0;
}
