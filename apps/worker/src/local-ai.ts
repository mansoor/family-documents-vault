import { LOCAL_AI_PROBE_MS, type AiReaderRunsAt } from '@fdv/shared';
import type { LocalAiSettings } from './ai-reader.js';
import type { OllamaReader } from './ollama-reader.js';

/**
 * The local AI reader set in .env (0.9.0, R4): FDV_LOCAL_AI_URL and
 * FDV_LOCAL_AI_MODEL, validated at start (http or https, no credentials in
 * it), the operator's own. Where they are set they win over any reader an
 * owner saved in Settings (AIR1, decision 8), for every household. Its
 * client is the Ollama reader (`ollama-reader.ts`, behind `AiReader`): kept
 * here are what the worker says of it for Settings (`local_ai_state`) and
 * how it is read from the configuration.
 */

export {
  OllamaReader as LocalAiClient,
  LOCAL_AI_CONNECT_MS,
  LOCAL_AI_FAILURES_TO_REST,
  LOCAL_AI_PROBE_TIMEOUT_MS,
  LOCAL_AI_REST_MS,
  LOCAL_AI_TAGS_MAX_BYTES,
  LOCAL_AI_TEST_MS,
  LOCAL_AI_WAIT_SLACK_MS,
  type LocalAiClientOptions,
  type Resolve,
} from './ollama-reader.js';
export type { LocalAiAnswer, LocalAiSettings, LocalAiWithout } from './ai-reader.js';

/**
 * What this worker found of the endpoint, said where the API reads it
 * (local_ai_state, 0081): the model and host the operator set — never the
 * URL's path — and whether it answered. A row a worker process; rows no
 * worker has said in a day go. The API counts a word only while it is fresh
 * (LOCAL_AI_STALE_MS).
 */
export async function recordLocalAi(
  admin: { query(sql: string, params?: unknown[]): Promise<unknown> },
  worker: string,
  settings: LocalAiSettings,
  state: 'reachable' | 'unreachable' | 'no_model',
  /** Where it was last found to run, by the address it resolved to (AIR1); null, not known. */
  runsAt: AiReaderRunsAt | null = null,
): Promise<void> {
  await admin.query(
    `insert into local_ai_state (worker, model, host, state, checked_at, kind, runs_at)
     values ($1, $2, $3, $4, now(), 'ollama', $5)
     on conflict (worker) do update
       set model = excluded.model, host = excluded.host, state = excluded.state,
           checked_at = now(), kind = excluded.kind, runs_at = excluded.runs_at`,
    [worker.slice(0, 200), settings.model, localAiHost(settings.url).slice(0, 300), state, runsAt],
  );
  await admin.query(`delete from local_ai_state where checked_at < now() - interval '1 day'`);
}

/**
 * Asks the endpoint whether it answers and has the model, now and every
 * `every` milliseconds while the worker runs, and says so (`record`).
 * Answers a function that stops it.
 */
export function keepProbingLocalAi(
  client: Pick<OllamaReader, 'probe'>,
  record: (state: 'reachable' | 'unreachable' | 'no_model') => void,
  every: number = LOCAL_AI_PROBE_MS,
): () => void {
  const say = () => {
    void client.probe().then(record, () => record('unreachable'));
  };
  say();
  const timer = setInterval(say, every);
  timer.unref();
  return () => clearInterval(timer);
}

/** The worker's settings for it, from its configuration: none, with no FDV_LOCAL_AI_URL. */
export function localAiSettings(c: {
  FDV_LOCAL_AI_URL?: URL | undefined;
  FDV_LOCAL_AI_MODEL?: string | undefined;
  FDV_LOCAL_AI_TIMEOUT_SECONDS: number;
}): LocalAiSettings | null {
  if (!c.FDV_LOCAL_AI_URL || !c.FDV_LOCAL_AI_MODEL) return null;
  return {
    url: c.FDV_LOCAL_AI_URL,
    model: c.FDV_LOCAL_AI_MODEL,
    timeoutMs: c.FDV_LOCAL_AI_TIMEOUT_SECONDS * 1000,
  };
}

/** What the endpoint is, as Settings shows it: its host and port, never a path or anything else. */
export function localAiHost(url: URL): string {
  return url.host;
}
