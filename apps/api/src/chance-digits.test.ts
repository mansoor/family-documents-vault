import { describe, expect, it } from 'vitest';
import { holdsDigits, withoutChanceDigits } from './test-harness.js';

/**
 * The helpers the "never in the log" checks use (0.9.0-dev.45): a short code
 * found where it leaked, however it was written, and never where a random
 * id, time or timing happens to hold the same digits.
 */
describe('looking for a short code in a log', () => {
  const code = '123456';

  it('catches a leak however it is written', () => {
    for (const leaked of [
      '{"msg":"sent","code":"123456"}',
      'code=123456&to=x',
      'Your code is 123456.',
      // After a JSON escape, in a stringified log or job.
      JSON.stringify({ text: 'Your code:\n123456' }),
      JSON.stringify({ text: 'tab\t123456' }),
      JSON.stringify({ text: 'quoted "123456"' }),
      // Run into a word.
      'code123456',
      '{"line":"code123456x"}',
    ]) {
      expect(holdsDigits(leaked, code), leaked).toBe(true);
    }
    // Spaced, as an email writes it.
    expect(holdsDigits('Your code is 123 456.', '123 456')).toBe(true);
    expect(holdsDigits(JSON.stringify({ text: 'is\n123 456' }), '123 456')).toBe(true);
  });

  it('is not fooled by digits a log holds by chance', () => {
    for (const chance of [
      // In a UUID.
      '{"reqId":"0f1e2d3c-4b5a-4123-9456-0a1b2c3d4e5f"}',
      'a8123456-0000-4000-8000-000000000000',
      // In a time, in milliseconds or as ISO 8601.
      '{"time":1763123456789}',
      '"at":"2026-11-15T12:34:56.123456Z"',
      // In a response time.
      '"responseTime":3.123456',
      '"responseTime":123456.5',
      // In a longer number, and a hash.
      'bytes 91234567',
      '"sha256":"ab12345612345612345612345612345612345612345612345612345612345678"',
    ]) {
      expect(holdsDigits(chance, code), chance).toBe(false);
    }
  });

  it('takes out ids, hashes, times and timings, and undoes JSON escapes', () => {
    expect(withoutChanceDigits('a\\nb\\"c\\u0041d')).toBe('a b c d');
    expect(
      withoutChanceDigits(
        '0f1e2d3c-4b5a-4123-9456-0a1b2c3d4e5f 2026-11-15T12:34:56Z 3.25 0123456789abcdef',
      ),
    ).toBe('<id> <time> <n> <hex>');
  });
});
