import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { stopApi } from './shutdown.js';

describe('stopping the API (5.37, R2-02)', () => {
  it('closes the proposal thread first, then the server, the queue and the database', async () => {
    const order: string[] = [];
    const step = (name: string) => () => {
      order.push(name);
      return Promise.resolve();
    };
    await stopApi({
      proposals: { close: step('proposals') },
      app: { close: step('app') },
      boss: { stop: step('boss') },
      db: { destroy: step('db') },
    });
    expect(order).toEqual(['proposals', 'app', 'boss', 'db']);
  });

  it("server.ts stops by it, with the process's proposal thread, and closes nothing on its own", async () => {
    const server = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/await stopApi\(\{ proposals: proposalPool, app, boss, db \}\);/);
    expect(server).not.toMatch(/\bapp\.close\(|\bboss\.stop\(|\bdb\.destroy\(/);
  });
});
