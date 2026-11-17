/**
 * How the API stops, on SIGTERM or SIGINT. The proposal thread first
 * (5.37, R2-02): a request waiting on it is answered — no proposal — at
 * once, not held until its deadline while the server waits for requests in
 * flight. Then what it consumes from the queue (0.9.0, APP4: an app's item
 * filed automatically), let finish the job in hand. Then the server, the
 * queue and the database.
 */
export async function stopApi(parts: {
  proposals: { close(): Promise<void> };
  consumers?: ReadonlyArray<{ stop(): Promise<void> }>;
  app: { close(): PromiseLike<unknown> };
  boss: { stop(options: { graceful: boolean }): Promise<unknown> };
  db: { destroy(): Promise<void> };
}): Promise<void> {
  await parts.proposals.close();
  for (const c of parts.consumers ?? []) await c.stop().catch(() => undefined);
  await parts.app.close();
  await parts.boss.stop({ graceful: false });
  await parts.db.destroy();
}
