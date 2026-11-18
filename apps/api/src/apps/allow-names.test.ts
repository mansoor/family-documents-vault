import { describe, expect, it } from 'vitest';
import { AllowNames, neverAllowed, type ResolveFamily } from './allow-names.js';

/**
 * The names in an app's allow-list (APP7), looked up and kept: each answer
 * for its TTL (ten seconds to five minutes), a failure for thirty seconds,
 * an answer up to an hour old while lookups fail, and never longer than
 * the timeout.
 */

function dns(
  table: Record<string, { v4?: string[]; v6?: string[]; ttl?: number } | 'fail' | 'hang'>,
) {
  const asked: string[] = [];
  const resolve: ResolveFamily = async (name, family) => {
    asked.push(`${name}/${family}`);
    const r = table[name];
    if (r === 'hang') return new Promise(() => undefined);
    if (r === 'fail') throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' });
    if (!r) throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' });
    const list = family === 4 ? r.v4 : r.v6;
    if (!list) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
    return list.map((address) => ({ address, ttl: r.ttl ?? 60 }));
  };
  return { table, asked, resolve };
}

describe('the names in an allow-list (0.9.0, APP7)', () => {
  it('answers both families, keeps them for their TTL, capped at five minutes', async () => {
    let now = 0;
    const d = dns({ 'a.example.com': { v4: ['203.0.113.1'], v6: ['2001:db8::1'], ttl: 3600 } });
    const names = new AllowNames({ resolve: d.resolve, now: () => now });
    expect(await names.addresses('a.example.com')).toEqual(['203.0.113.1', '2001:db8::1']);
    now += 4 * 60_000;
    await names.addresses('a.example.com');
    expect(d.asked).toHaveLength(2);
    now += 2 * 60_000;
    await names.addresses('a.example.com');
    expect(d.asked).toHaveLength(4);
  });

  it('a short TTL is kept ten seconds at least; lookups at once are one lookup', async () => {
    let now = 0;
    const d = dns({ 'b.example.com': { v4: ['203.0.113.2'], ttl: 0 } });
    const names = new AllowNames({ resolve: d.resolve, now: () => now });
    await Promise.all([1, 2, 3].map(() => names.addresses('b.example.com')));
    expect(d.asked).toEqual(['b.example.com/4', 'b.example.com/6']);
    now += 9_000;
    await names.addresses('b.example.com');
    expect(d.asked).toHaveLength(2);
    now += 2_000;
    await names.addresses('b.example.com');
    expect(d.asked).toHaveLength(4);
  });

  it('a failure lets nothing in and is kept thirty seconds; an answer under an hour old stands meanwhile', async () => {
    let now = 0;
    const d = dns({ 'c.example.com': 'fail' });
    const names = new AllowNames({ resolve: d.resolve, now: () => now });
    expect(await names.addresses('c.example.com')).toBeNull();
    now += 20_000;
    expect(await names.addresses('c.example.com')).toBeNull();
    expect(d.asked).toHaveLength(2);
    now += 15_000;
    d.table['c.example.com'] = { v4: ['203.0.113.3'], ttl: 60 };
    expect(await names.addresses('c.example.com')).toEqual(['203.0.113.3']);
    // Its DNS fails: the last answer stands, for an hour past its TTL.
    d.table['c.example.com'] = 'fail';
    now += 61_000;
    expect(await names.addresses('c.example.com')).toEqual(['203.0.113.3']);
    now += 61 * 60_000;
    expect(await names.addresses('c.example.com')).toBeNull();
  });

  it('a lookup that takes longer than the timeout has failed; no such name is no address', async () => {
    const d = dns({ 'slow.example.com': 'hang' });
    const names = new AllowNames({ resolve: d.resolve, timeoutMs: 50 });
    const started = Date.now();
    expect(await names.addresses('slow.example.com')).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await names.addresses('missing.example.com')).toEqual([]);
  });

  it('never keeps a loopback or unspecified address from an answer; a fresh answer is told without a lookup', async () => {
    const d = dns({
      'mixed.example.com': {
        v4: ['127.0.0.1', '127.200.0.9', '0.0.0.0', '203.0.113.9'],
        v6: ['::1', '::', '::ffff:127.0.0.1', '2001:db8::9'],
      },
    });
    const names = new AllowNames({ resolve: d.resolve });
    expect(names.fresh('mixed.example.com')).toBeUndefined();
    expect(await names.addresses('mixed.example.com')).toEqual(['203.0.113.9', '2001:db8::9']);
    expect(names.fresh('mixed.example.com')).toEqual(['203.0.113.9', '2001:db8::9']);
    expect(d.asked).toHaveLength(2);
    for (const a of ['127.0.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1']) {
      expect(neverAllowed(a), a).toBe(true);
    }
    expect(neverAllowed('203.0.113.9')).toBe(false);
    expect(neverAllowed('2001:db8::9')).toBe(false);
  });
});
