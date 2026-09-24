import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api.js';
import { createUploadKeys, whileInProgress } from './upload-keys.js';

const file = (name: string, body = 'x') =>
  new File([body], name, { type: 'application/pdf', lastModified: 1_700_000_000_000 });

describe('upload keys in the web app', () => {
  it('the same file chosen again after a failure keeps its key; a save or another file starts a new one', () => {
    const keys = createUploadKeys();
    const first = keys.keyFor(file('passport.pdf'));
    expect(keys.keyFor(file('passport.pdf'))).toBe(first);
    expect(keys.keyFor(file('council-tax.pdf'))).not.toBe(first);
    const second = keys.keyFor(file('passport.pdf'));
    expect(second).not.toBe(first);
    keys.saved();
    expect(keys.keyFor(file('passport.pdf'))).not.toBe(second);
  });

  it('an upload already on its way is asked about again after the wait the vault gave', async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await whileInProgress(
      async () => {
        n += 1;
        if (n < 3) {
          throw new ApiRequestError(
            409,
            'upload_in_progress',
            'This upload is already on its way.',
            undefined,
            {
              retriable: true,
              retryAfterSeconds: 5,
            },
          );
        }
        return 'stored';
      },
      { wait: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe('stored');
    expect(waits).toEqual([5000, 5000]);
  });

  it('any other refusal is not retried, and a busy upload is given up on in the end', async () => {
    const reused = new ApiRequestError(409, 'idempotency_key_reused', 'Already used.');
    let n = 0;
    await expect(
      whileInProgress(
        async () => {
          n += 1;
          throw reused;
        },
        { wait: async () => undefined },
      ),
    ).rejects.toBe(reused);
    expect(n).toBe(1);

    const busy = new ApiRequestError(409, 'upload_in_progress', 'On its way.', undefined, {
      retriable: true,
    });
    n = 0;
    await expect(
      whileInProgress(
        async () => {
          n += 1;
          throw busy;
        },
        { tries: 3, wait: async () => undefined },
      ),
    ).rejects.toBe(busy);
    expect(n).toBe(3);
  });
});
