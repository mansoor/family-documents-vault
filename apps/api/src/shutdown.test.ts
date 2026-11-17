import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { stopApi } from './shutdown.js';

describe('stopping the API (5.37, R2-02)', () => {
  it('closes the proposal thread first, then its consumers, the server, the queue and the database', async () => {
    const order: string[] = [];
    const step = (name: string) => () => {
      order.push(name);
      return Promise.resolve();
    };
    await stopApi({
      proposals: { close: step('proposals') },
      // What it consumes (0.9.0, APP4): stopped before the server, and one
      // that fails to stop keeps nothing else from stopping.
      consumers: [
        { stop: step('apps.file_ready') },
        { stop: () => Promise.reject(new Error('gone already')) },
      ],
      app: { close: step('app') },
      boss: { stop: step('boss') },
      db: { destroy: step('db') },
    });
    expect(order).toEqual(['proposals', 'apps.file_ready', 'app', 'boss', 'db']);
  });

  it("server.ts stops by it, with the process's proposal thread, and closes nothing on its own", async () => {
    const server = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(
      /await stopApi\(\{ proposals: proposalPool, consumers, app, boss, db \}\);/,
    );
    expect(server).not.toMatch(/\bapp\.close\(|\bboss\.stop\(|\bdb\.destroy\(/);
  });
});
