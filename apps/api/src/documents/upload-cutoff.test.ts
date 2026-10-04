import { randomUUID } from 'node:crypto';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, Tokens } from '@fdv/shared';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import { cutOff, UPLOAD_LINGER_MS } from './routes.js';

/**
 * An upload over the size limit is cut off (the 5.30 review, X530-3): the
 * answer is 413, and a few seconds later the connection closes, rather than
 * the rest being read to nowhere for as long as the client goes on sending. nginx's
 * cap did that before the TLS overlay sent the API's requests to the API
 * itself. Over a real socket: the injected requests of the other tests have
 * no connection to close.
 */
describe.skipIf(!testAdminUrl())('an upload over the limit', () => {
  let h: Harness;
  let owner: Tokens;
  let port = 0;
  let doc = '';

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Lease', type_key: 'utility_bill' },
    });
    doc = created.json<DocumentView>().id;
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    port = (h.app.server.address() as AddressInfo).port;
  }, 120_000);
  afterAll(() => h.close());

  /**
   * Sends the headers of an upload that says it is 64 MB, and 6 MB of it —
   * past the harness's 5 MB — then nothing more. Answers with what came
   * back, and whether the vault closed the connection within the wait.
   */
  const oversized = async (path: string, field: string) => {
    const boundary = `----fdv${randomUUID().replace(/-/g, '')}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="big.pdf"\r\n` +
        'Content-Type: application/pdf\r\n\r\n%PDF-1.4\n',
    );
    const socket: Socket = connect(port, '127.0.0.1');
    await new Promise<void>((ok, fail) => socket.once('connect', ok).once('error', fail));
    let answer = '';
    socket.on('data', (d: Buffer) => {
      answer += d.toString('latin1');
    });
    // A reset once the vault closes it, while this still has bytes to send.
    socket.on('error', () => undefined);
    const closed = new Promise<boolean>((ok) => {
      socket.once('close', () => ok(true));
      setTimeout(() => ok(false), UPLOAD_LINGER_MS + 4_000);
    });
    socket.write(
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Authorization: Bearer ${owner.access_token}\r\n` +
        `Idempotency-Key: ${randomUUID()}\r\n` +
        `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
        `Content-Length: ${64 * 1024 * 1024}\r\nConnection: keep-alive\r\n\r\n`,
    );
    socket.write(head);
    socket.write(Buffer.alloc(6 * 1024 * 1024, 0x41));
    const wasClosed = await closed;
    socket.destroy();
    return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1]), answer, wasClosed };
  };

  it('a new version: answered 413, and the connection closes with the rest unsent', async () => {
    const r = await oversized(`/api/v1/documents/${doc}/versions`, 'file');
    expect(r.status, r.answer.slice(0, 300)).toBe(413);
    expect(r.answer).toContain('"too_large"');
    expect(r.wasClosed).toBe(true);
  });

  it('a capture: the same', async () => {
    const r = await oversized('/api/v1/capture', 'file');
    expect(r.status, r.answer.slice(0, 300)).toBe(413);
    expect(r.wasClosed).toBe(true);
    // And the vault goes on answering.
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) });
    expect(me.statusCode).toBe(200);
  });
});

/**
 * A request made in-process (Fastify's inject, as most tests and nothing in
 * production use) has a stand-in for a socket with nothing to close: cutting
 * it off must do nothing, not throw from a timer, which would end the process
 * (seen in 0.5.33's release gate).
 */
describe('cutting off an upload with no connection to close', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing, and throws nothing', () => {
    vi.useFakeTimers();
    const raw = Object.assign(new EventEmitter(), { complete: false, socket: {} });
    const replyRaw = new EventEmitter();
    cutOff({ raw } as unknown as FastifyRequest, { raw: replyRaw } as unknown as FastifyReply);
    replyRaw.emit('finish');
    expect(() => vi.advanceTimersByTime(UPLOAD_LINGER_MS + 1)).not.toThrow();
  });

  it('a real connection still sending is closed', () => {
    vi.useFakeTimers();
    const destroy = vi.fn();
    const raw = Object.assign(new EventEmitter(), { complete: false, socket: { destroy } });
    const replyRaw = new EventEmitter();
    cutOff({ raw } as unknown as FastifyRequest, { raw: replyRaw } as unknown as FastifyReply);
    replyRaw.emit('finish');
    vi.advanceTimersByTime(UPLOAD_LINGER_MS + 1);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
