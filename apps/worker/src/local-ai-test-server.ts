import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A fake Ollama for the tests (0.9.0, R4): no model, answers it is told to
 * give — a form, malformed JSON, far too much, slowly, never, an error —
 * and every request it was sent, kept, so a test can say what left the
 * worker. Listens on 127.0.0.1 alone.
 */

export type FakeAnswer =
  /** A form, as the model's own answer (`message.content`). */
  | { form: Record<string, unknown> }
  /** The model's answer exactly as given: not JSON, say, or an injection's echo. */
  | { content: string }
  /** The whole body as given. */
  | { raw: string }
  /** This many bytes of padding inside a well-formed reply. */
  | { huge: number }
  /** An HTTP status and nothing else. */
  | { status: number }
  /** No answer, ever: the connection held open. */
  | { hang: true };

export interface FakeRequest {
  method: string;
  path: string;
  host: string | undefined;
  body: string;
}

export interface FakeOllama {
  url: string;
  port: number;
  requests: FakeRequest[];
  /** What the next requests to /api/chat get, in order; the last is kept for any after. */
  answers: FakeAnswer[];
  /** How long each answer waits before it is sent. */
  delayMs: number;
  /** The models /api/tags lists. */
  models: string[];
  /** What /api/tags answers with: 200 and the list, unless a test says another status. */
  tagsStatus: number;
  close(): Promise<void>;
}

const envelope = (content: string) =>
  JSON.stringify({
    model: 'fake',
    created_at: new Date(0).toISOString(),
    message: { role: 'assistant', content },
    done: true,
    total_duration: 1,
  });

export async function startFakeOllama(): Promise<FakeOllama> {
  const sockets = new Set<Socket>();
  const state: Omit<FakeOllama, 'url' | 'port' | 'close'> = {
    requests: [],
    answers: [{ form: blankForm() }],
    delayMs: 0,
    models: ['qwen2.5:3b-instruct'],
    tagsStatus: 200,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        host: req.headers.host,
        body,
      });
      if (req.url === '/api/tags') {
        if (state.tagsStatus !== 200) {
          res.writeHead(state.tagsStatus);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: state.models.map((name) => ({ name, model: name })) }));
        return;
      }
      const answer =
        state.answers.length > 1 ? (state.answers.shift() as FakeAnswer) : state.answers[0];
      const send = () => {
        if (!answer || 'hang' in answer) return;
        if ('status' in answer) {
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if ('raw' in answer) res.end(answer.raw);
        else if ('content' in answer) res.end(envelope(answer.content));
        else if ('huge' in answer) res.end(envelope('x'.repeat(answer.huge)));
        else res.end(envelope(JSON.stringify(answer.form)));
      };
      if (state.delayMs > 0) setTimeout(send, state.delayMs);
      else send();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  });
}

/** A form that says nothing: every key, nothing known. */
export function blankForm(): Record<string, unknown> {
  return {
    kind: 'unknown',
    whose: 'unknown',
    issuer: null,
    issued: null,
    expires: null,
    identifier: null,
  };
}
