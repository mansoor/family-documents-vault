import type { Tokens } from '@fdv/shared';
import { expect } from 'vitest';
import type { Api } from '../api.js';
import { ApiRequestError, isSessionOver } from '../errors.js';
import { multipartBody } from '../multipart.js';
import { negotiate } from '../negotiate.js';

/**
 * What any vault a client talks to must do — the real API and the fake
 * alike. `apps/api/src/client-contract.test.ts` runs these against the
 * real server through `@fdv/client`; `fake.test.ts` runs them against
 * `createFakeVault()`. A client tested against the fake is then tested
 * against something that behaves like the server where it matters.
 *
 * They run in order against one fresh vault, sharing `ContractContext`.
 */

export interface ContractContext {
  email: string;
  password: string;
  tokens?: Tokens;
  spent?: string;
}

export interface Scenario {
  name: string;
  run: (api: Api, ctx: ContractContext) => Promise<void>;
}

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const CAPTURE_KEY = '4f1c2b3a-9d8e-4c7b-8a6f-5e4d3c2b1a09';

async function refusal(p: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRequestError);
    return err as ApiRequestError;
  }
  throw new Error('expected the vault to refuse');
}

const signIn = async (api: Api, ctx: ContractContext): Promise<Tokens> => {
  const t = await api.signIn(ctx.email, ctx.password);
  expect('access_token' in t).toBe(true);
  return t as Tokens;
};

export const contractScenarios: Scenario[] = [
  {
    name: 'a new vault says what it is, and that it needs setting up',
    run: async (api) => {
      const outcome = negotiate(await api.capabilities(), {
        clientVersion: '0.1.0',
        // About setup, not versions: every server version is new enough.
        minServerVersion: '0.0.0',
      });
      expect(outcome.kind).toBe('setup_required');
    },
  },
  {
    name: 'setting it up opens a session for the first owner',
    run: async (api, ctx) => {
      const t = await api.setup({
        household_name: 'The Contract family',
        display_name: 'Owner',
        email: ctx.email,
        password: ctx.password,
      });
      expect(t.role).toBe('owner');
      expect(t.access_token).toBeTruthy();
      expect(t.refresh_token).toBeTruthy();
      ctx.tokens = t;
    },
  },
  {
    name: 'a wrong password is an ordinary refusal, not a dead session',
    run: async (api, ctx) => {
      const err = await refusal(api.signIn(ctx.email, 'not the right password'));
      expect(err.status).toBe(401);
      expect(err.code).toBe('invalid_credentials');
      expect(isSessionOver(err)).toBe(false);
    },
  },
  {
    name: 'refreshing rotates the refresh token',
    run: async (api, ctx) => {
      const before = await signIn(api, ctx);
      const after = await api.refresh(before.refresh_token);
      expect(after.refresh_token).not.toBe(before.refresh_token);
      expect(after.access_token).toBeTruthy();
      ctx.spent = before.refresh_token;
      ctx.tokens = after;
    },
  },
  {
    name: 'a spent refresh token, presented again, ends the whole session',
    run: async (api, ctx) => {
      const replay = await refusal(api.refresh(ctx.spent as string));
      expect(replay.status).toBe(401);
      expect(isSessionOver(replay)).toBe(true);
      // The thief's replay took the real holder's session with it.
      const holder = await refusal(api.refresh((ctx.tokens as Tokens).refresh_token));
      expect(isSessionOver(holder)).toBe(true);
    },
  },
  {
    name: 'a document created is a document listed',
    run: async (api, ctx) => {
      const t = await signIn(api, ctx);
      ctx.tokens = t;
      const doc = await api.createDocument(t.access_token, { title: 'Contract water bill' });
      const page = await api.documents(t.access_token);
      expect(page.items.map((d) => d.id)).toContain(doc.id);
    },
  },
  {
    name: 'a capture sent as bytes is stored once, however often it is retried',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      const form = multipartBody([
        { name: 'file', filename: 'scan.pdf', contentType: 'application/pdf', bytes: PDF },
      ]);
      const body = { kind: 'bytes' as const, bytes: form.bytes, contentType: form.contentType };
      const first = await api.capture(token, body, CAPTURE_KEY);
      expect(first.document_id).toBeTruthy();
      const again = await api.capture(token, body, CAPTURE_KEY);
      expect(again.document_id).toBe(first.document_id);
      expect(again.version_id).toBe(first.version_id);
    },
  },
  {
    name: 'signing out ends the session',
    run: async (api, ctx) => {
      const token = (ctx.tokens as Tokens).access_token;
      await api.logout(token);
      const err = await refusal(api.me(token));
      expect(isSessionOver(err)).toBe(true);
    },
  },
];
