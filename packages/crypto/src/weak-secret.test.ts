import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  databasePasswordProblem,
  estimatedBits,
  masterSecretProblem,
  setupTokenProblem,
} from './weak-secret.js';

const EXAMPLE = new URL('../../../.env.example', import.meta.url);

/** A setting's value in .env.example. */
async function exampleValue(name: string): Promise<string> {
  const line = (await readFile(EXAMPLE, 'utf8')).split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not in .env.example`);
  return line.slice(name.length + 1).trim();
}

describe('secrets the vault will not start with', () => {
  it('refuses the example file’s master key, and says what to do', async () => {
    const placeholder = await exampleValue('FDV_MASTER_KEY');
    const said = masterSecretProblem(placeholder);
    expect(said).toMatch(/placeholder/);
    expect(said).toContain('scripts/gen-env.mjs');
    expect(said).toContain('rotate-master-key');
  });

  it('refuses a key too easy to guess', () => {
    for (const weak of [
      'k'.repeat(43),
      'a'.repeat(64),
      'abababababababababababababababababab',
      'passwordpasswordpasswordpassword',
      '0123012301230123012301230123012301230123',
    ]) {
      expect(masterSecretProblem(weak), weak).toMatch(/too easy to guess/);
    }
  });

  it('takes what gen-env makes, a hex key, and a passphrase of random words', () => {
    for (let i = 0; i < 200; i++) {
      expect(masterSecretProblem(randomBytes(32).toString('base64url'))).toBeNull();
      expect(masterSecretProblem(randomBytes(32).toString('hex'))).toBeNull();
      expect(masterSecretProblem(randomBytes(32).toString('base64'))).toBeNull();
    }
    expect(masterSecretProblem('orbit-mango-velvet-tundra-quiz-harbour-lilac')).toBeNull();
    // The keys this repository's own tests start a vault with.
    expect(masterSecretProblem('the-key-after-a-rotation-that-is-not-in-use-000')).toBeNull();
    expect(masterSecretProblem('worker-start-test-master-secret-32-bytes-000')).toBeNull();
  });

  it('measures what a string could hold by its own letters', () => {
    expect(estimatedBits('')).toBe(0);
    expect(estimatedBits('aaaa')).toBe(0);
    expect(estimatedBits('ab')).toBeCloseTo(2);
  });

  it('refuses the example file’s database passwords, and nothing else', async () => {
    const owner = await exampleValue('FDV_DB_PASSWORD');
    const app = await exampleValue('FDV_DB_APP_PASSWORD');
    expect(
      databasePasswordProblem(`postgres://fdv:${owner}@postgres:5432/fdv`, 'DATABASE_ADMIN_URL'),
    ).toMatch(/DATABASE_ADMIN_URL uses the example file's placeholder password/);
    expect(
      databasePasswordProblem(`postgres://fdv_app:${app}@postgres:5432/fdv`, 'DATABASE_URL'),
    ).toMatch(/DATABASE_URL/);
    const real = randomBytes(24).toString('base64url');
    expect(
      databasePasswordProblem(`postgres://fdv_app:${real}@postgres:5432/fdv`, 'DATABASE_URL'),
    ).toBeNull();
    // No password at all (a socket, a .pgpass) is not this check's to refuse.
    expect(databasePasswordProblem('postgres://fdv@localhost/fdv', 'DATABASE_URL')).toBeNull();
    expect(databasePasswordProblem('not a url', 'DATABASE_URL')).toBeNull();
  });

  it('refuses a setup code too easy to guess, however long, and takes what gen-env makes', () => {
    for (const weak of [
      'a'.repeat(32),
      '1234567812345678',
      'replace-with-a-setup-code',
      'abcabcabcabcabcabcabc',
    ]) {
      expect(setupTokenProblem(weak), weak).toMatch(/too easy to guess/);
    }
    for (let i = 0; i < 200; i++) {
      expect(setupTokenProblem(randomBytes(16).toString('base64url'))).toBeNull();
    }
  });
});
