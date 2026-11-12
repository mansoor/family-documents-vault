import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  AI_READER_KINDS,
  can,
  LOCAL_AI_STALE_MS,
  type LocalAiNotice,
  type LocalAiServerView,
  type LocalAiSettingsView,
  type SettingsCheckView,
} from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { SettingsCheckService } from '../settings-checks.js';
import type { AiReaderService } from './ai-reader.js';

/**
 * The local AI reader, an owner's switch for the household (0.9.0, R4).
 *
 * Where the model is — FDV_LOCAL_AI_URL and FDV_LOCAL_AI_MODEL — is the
 * operator's alone, in .env, and the worker's: the API never has it, and
 * nothing here can set it (a URL an owner could type would point the server
 * at its own network, as the O1 review found of the mailbox). What this
 * shows is what the workers said of it lately (local_ai_state, 0081): the
 * model, its host and port, and whether it answered. An owner turns it on or
 * off for the household — on only while a worker has it — and asks the
 * worker to Test it (a settings check: a tiny fixed prompt, no paper).
 *
 * Since AIR1 (0.9.0) an owner may instead set the reader in Settings →
 * Reading → AI reader (`AiReaderService`, with the guards that review asked
 * for): where .env sets one it still wins; else the switch turns on the one
 * saved, once its Test passed.
 */

const ownersOnly = () =>
  new ApiError(403, 'forbidden', 'Only an owner can change how the vault reads papers.');
const notSetUp = (settings: boolean) =>
  new ApiError(
    409,
    'local_ai_unavailable',
    settings
      ? 'The local AI can’t be turned on yet: set up the AI reader below, and test it, first.'
      : 'The local AI can’t be turned on: it isn’t set up on this server. Whoever runs the vault sets it in .env (FDV_LOCAL_AI_URL and FDV_LOCAL_AI_MODEL).',
  );

export class LocalAiService {
  constructor(
    private readonly db: Db,
    private readonly checks: SettingsCheckService | null = null,
    /** The reader an owner saves in Settings (AIR1); none, and only .env's. */
    private readonly readers: AiReaderService | null = null,
  ) {}

  /**
   * The local AI as the workers said it lately: the newest word of any
   * worker within LOCAL_AI_STALE_MS (on the database's clock, as they write
   * it), or not set up. Not tenant data: the installation's.
   */
  async server(): Promise<LocalAiServerView> {
    const row = await this.db
      .selectFrom('local_ai_state')
      .select(['model', 'host', 'state', 'checked_at', 'kind', 'runs_at'])
      .where(
        'checked_at',
        '>',
        sql<Date>`now() - make_interval(secs => ${LOCAL_AI_STALE_MS / 1000})`,
      )
      .orderBy('checked_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return { state: 'not_set_up' };
    return {
      state: row.state,
      model: row.model,
      host: row.host,
      checked_at: new Date(row.checked_at).toISOString(),
      kind: AI_READER_KINDS.includes(row.kind) ? row.kind : 'ollama',
      runs_at: row.runs_at,
    };
  }

  /**
   * `features.local_ai`: a worker has one set up, and said so lately; or
   * (AIR1) an owner may set one in Settings — so that every client, an older
   * one too, asks GET /household/reading/notice and tells whoever adds
   * papers when a reader reads them (the R4 review, M1).
   */
  async available(): Promise<boolean> {
    if (this.readers?.offered()) return true;
    return (await this.server()).state !== 'not_set_up';
  }

  /** GET /household/reading's local AI: the switch, and the server's endpoint as found. */
  async get(p: Principal): Promise<LocalAiSettingsView> {
    if (p.role !== 'owner') throw ownersOnly();
    // Asked before the transaction, never inside it (the R2 re-check).
    const server = await this.server();
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('household')
        .select('local_ai')
        .where('id', '=', p.householdId)
        .executeTakeFirst();
      return { local_ai: row?.local_ai === true, local_ai_server: server };
    }).then(async (v) => ({
      ...v,
      local_ai_reader: this.readers ? await this.readers.summary(p, server) : null,
    }));
  }

  /**
   * PUT /household/reading's local AI: on — only while a worker has one set
   * up (409 local_ai_unavailable) — or off, always. Papers read from now on
   * are read so; a card already read keeps what it was read with. Said in
   * the activity log, for the owners. The database holds it to owners too
   * (household_local_ai_rule).
   */
  async set(p: Principal, on: boolean, meta: RequestMeta): Promise<LocalAiSettingsView> {
    const got = await this.setSwitches(p, { local_ai: on }, meta);
    return {
      local_ai: got.local_ai,
      local_ai_server: got.local_ai_server,
      ...(got.local_ai_reader !== undefined ? { local_ai_reader: got.local_ai_reader } : {}),
    };
  }

  /**
   * PUT /household/reading (0.9.0): the reading model's switch (R2) and the
   * local AI's (R4), either or both, in one transaction — both changed, or
   * neither — each change said in the activity log as its own line. The
   * local AI on only while a worker has one set up (409, and nothing
   * changed).
   */
  async setSwitches(
    p: Principal,
    input: { reading_model?: boolean | undefined; local_ai?: boolean | undefined },
    meta: RequestMeta,
  ): Promise<LocalAiSettingsView & { reading_model: boolean }> {
    if (p.role !== 'owner') throw ownersOnly();
    // Asked before the transaction, never inside it (the R2 re-check).
    const server = await this.server();
    // .env's reader, else (AIR1) the one saved in Settings once tested.
    const reader = this.readers ? await this.readers.summary(p, server) : null;
    if (input.local_ai === true && server.state === 'not_set_up' && !reader?.ready) {
      throw notSetUp(this.readers?.offered() === true);
    }
    const done = await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('household')
        .select(['local_ai', 'reading_model'])
        .where('id', '=', p.householdId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const after = {
        local_ai: input.local_ai ?? before.local_ai,
        reading_model: input.reading_model ?? before.reading_model,
      };
      const changed = (['reading_model', 'local_ai'] as const).filter(
        (k) => after[k] !== before[k],
      );
      if (changed.length > 0) {
        await trx.updateTable('household').set(after).where('id', '=', p.householdId).execute();
      }
      for (const k of changed) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action:
            k === 'local_ai' ? 'household.local_ai_changed' : 'household.reading_model_changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: { [k]: after[k] },
          ip: meta.ip,
        });
      }
      return { ...after, local_ai_server: server };
    });
    return this.readers ? { ...done, local_ai_reader: reader } : done;
  }

  /**
   * GET /household/reading/notice (the R4 review, M1): for whoever adds
   * papers, whether this household's batches are read by the local AI, and
   * on which host — said where they add them. Nothing more: never the
   * model, never whether it answered.
   */
  async notice(p: Principal): Promise<LocalAiNotice> {
    if (!can(p.role, 'document.add')) {
      throw new ApiError(403, 'forbidden', 'Only somebody who adds documents is told this.');
    }
    const server = await this.server();
    const got = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('household')
        .select('local_ai')
        .where('id', '=', p.householdId)
        .executeTakeFirst();
      // The household's own reader, once tested (AIR1): its kind, address
      // and where it runs alone, for whoever adds papers (0089).
      const own =
        this.readers?.offered() === true
          ? (
              await sql<{
                kind: string;
                base_url: string | null;
                runs_at: string;
              }>`select kind, base_url, runs_at from ai_reader_notice()`.execute(trx)
            ).rows[0]
          : undefined;
      return { on: row?.local_ai === true, own };
    });
    if (!got.on) return { local_ai: false, host: null };
    // .env's reader wins (AIR1, decision 8).
    if (server.state !== 'not_set_up') {
      return {
        local_ai: true,
        host: server.host,
        kind: server.kind ?? 'ollama',
        runs_at: server.runs_at ?? null,
      };
    }
    const own = got.own;
    if (own && AI_READER_KINDS.includes(own.kind as never)) {
      return {
        local_ai: true,
        host: own.base_url ? new URL(own.base_url).host : 'api.anthropic.com',
        kind: own.kind as NonNullable<LocalAiNotice['kind']>,
        runs_at: own.runs_at === 'own_network' || own.runs_at === 'cloud' ? own.runs_at : null,
      };
    }
    return { local_ai: false, host: null };
  }

  /** POST /household/reading/local-ai/test: Test, answered by the worker (GET /settings-checks/{id}). */
  async test(p: Principal): Promise<SettingsCheckView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (!this.checks) {
      throw new ApiError(503, 'unavailable', 'The worker can’t be asked just now.', {
        retriable: true,
      });
    }
    return this.checks.ask(p, 'local_ai', null);
  }
}

/**
 * POST /household/reading/local-ai/test (0.9.0, R4), an owner's. The switch
 * itself is GET and PUT /household/reading, beside the reading model's
 * (reading-check/routes.ts): the body takes the switches and nothing else,
 * so no endpoint, model or URL can be sent (422).
 */
export function registerLocalAi(app: FastifyInstance, ai: LocalAiService): void {
  const owners = {
    preHandler: [
      app.requireAuth,
      async (req: FastifyRequest) => {
        if (req.principal && req.principal.role !== 'owner') throw ownersOnly();
      },
    ],
  };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  // Whoever adds papers is told they are read by the local AI (M1).
  app.get('/api/v1/household/reading/notice', { preHandler: app.requireAuth }, async (req) =>
    ai.notice(principal(req)),
  );
  app.post('/api/v1/household/reading/local-ai/test', owners, async (req, reply) =>
    reply.status(202).send(await ai.test(principal(req))),
  );
}
