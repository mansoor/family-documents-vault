import { randomUUID } from 'node:crypto';
import {
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { BatchDetail, BatchItemView, DetailProposal, Tokens } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * An end date on the page, not on the card (0.9.0, R3; the re-check), in
 * the API: where the worker sealed beside an item's proposal which kinds
 * complete without an expiry the pages label one of (`expiry_labels`), a
 * card of such a kind with no expiry — an employment contract here — is
 * Check, "Expiry on the page, not read", never Ready; without them, or for
 * another kind, the same card is Ready. The worker is not here: what it
 * seals is planted as it seals it.
 */

const PDF = () => Buffer.from(`%PDF-1.4\n% contract ${randomUUID()}\n%%EOF\n`);

describe.skipIf(!testAdminUrl())('an expiry on the page, not read (R3)', () => {
  let h: Harness;
  let owner: Tokens;
  let hh: string;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    hh = owner.household_id;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const call = (method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(owner),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  /** An item read as the worker reads it, its proposal sealed with what is beside it. */
  const read = async (sealed: Record<string, unknown>) => {
    const made = await call('POST', '/api/v1/batches', {});
    expect(made.statusCode, made.body).toBe(201);
    const batch = made.json<BatchDetail>();
    const form = new FormData();
    form.append('file', PDF(), { filename: 'contract.pdf', contentType: 'application/pdf' });
    const sent = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batch.id}/items`,
      headers: { ...h.as(owner), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const itemId = sent.json<BatchItemView>().id;
    await withSystem(h.db, hh, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${itemId}`,
      );
      await trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          preview_state: 'ready',
          preview_pages: 1,
          text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(itemId)),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify(sealed)),
            itemProposalsBinding(itemId),
          ),
        })
        .where('id', '=', itemId)
        .execute();
    });
    const got = await call('GET', `/api/v1/batches/${batch.id}`);
    expect(got.statusCode, got.body).toBe(200);
    return got.json<BatchDetail>().items.find((i) => i.id === itemId) as BatchItemView;
  };

  it('a contract whose end date was not read is Check; the same card without its label is Ready', async () => {
    const proposal: DetailProposal = {
      type_key: { value: 'employment_contract', confidence: 0.95, cue: 'kind_words' },
      owner_member_id: { value: owner.member_id, confidence: 0.9, cue: 'name_labelled' },
      issued: {
        value: { date: '2025-01-06', precision: 'day' },
        confidence: 0.82,
        cue: 'issue_label',
      },
    };
    const ready = await read({ v: 1, proposal });
    expect(ready.level).toBe('ready');
    const unread = await read({ v: 1, proposal, expiry_labels: ['employment_contract'] });
    expect(unread.level).toBe('check');
    expect(unread.tags?.map((t) => t.words)).toContain('Expiry on the page, not read');
    // Another kind's label, or anything but a list of kinds, is nothing said.
    expect((await read({ v: 1, proposal, expiry_labels: ['property_deed'] })).level).toBe('ready');
    expect((await read({ v: 1, proposal, expiry_labels: 'employment_contract' })).level).toBe(
      'ready',
    );
  }, 120_000);
});
