/**
 * Semantic version helpers used for capability negotiation.
 *
 * One official app must work against self-hosted servers that are months or
 * years behind, so both sides compare versions before doing anything else.
 * Only the `major.minor.patch` core is compared; pre-release and build
 * metadata are ignored on purpose — a `1.4.0-rc.1` server is treated as `1.4.0`.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(input: string): SemVer {
  const m = SEMVER.exec(input.trim());
  if (!m) throw new Error(`not a semantic version: "${input}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Returns a negative number if a < b, zero if equal, positive if a > b. */
export function compareVersions(a: string | SemVer, b: string | SemVer): number {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/** True when `actual` satisfies a `minimum` requirement (>=). */
export function meetsMinimum(actual: string, minimum: string): boolean {
  return compareVersions(actual, minimum) >= 0;
}
