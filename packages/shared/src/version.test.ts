import { describe, expect, it } from 'vitest';
import { compareVersions, meetsMinimum, parseVersion } from './version.js';

describe('parseVersion', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseVersion('1.4.2')).toEqual({ major: 1, minor: 4, patch: 2 });
    expect(parseVersion('v0.10.0')).toEqual({ major: 0, minor: 10, patch: 0 });
  });

  it('ignores pre-release and build metadata', () => {
    expect(parseVersion('1.4.0-rc.1')).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(parseVersion('1.4.0+build.7')).toEqual({ major: 1, minor: 4, patch: 0 });
  });

  it('rejects anything that is not a semantic version', () => {
    expect(() => parseVersion('1.4')).toThrow(/not a semantic version/);
    expect(() => parseVersion('latest')).toThrow(/not a semantic version/);
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
});

describe('meetsMinimum', () => {
  it('is inclusive at the boundary', () => {
    expect(meetsMinimum('1.2.0', '1.2.0')).toBe(true);
    expect(meetsMinimum('1.2.1', '1.2.0')).toBe(true);
    expect(meetsMinimum('1.1.9', '1.2.0')).toBe(false);
  });
});
