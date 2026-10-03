import { describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import type { ClientDbWorker } from './client-db.js';

function fakeDb() {
  const writes: Array<() => void> = [];
  const put = vi.fn(
    () =>
      new Promise<void>(resolve => {
        writes.push(resolve);
      }),
  );

  return {
    db: { putResourceWithSnapshot: put } as unknown as ClientDbWorker,
    put,
    settleAll: async () => {
      writes.splice(0).forEach(resolve => resolve());
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('Store.persistState', () => {
  const jsonAd = '{"@id":"did:ad:x","name":"a"}';
  const snapshot = new Uint8Array([1, 2, 3]);

  it('writes an unchanged state once', async () => {
    const store = new Store();
    const { db, put, settleAll } = fakeDb();
    const first = store.persistState(db, 'did:ad:x', jsonAd, snapshot);
    const second = store.persistState(db, 'did:ad:x', jsonAd, snapshot);
    await settleAll();
    await Promise.all([first, second]);
    await store.persistState(db, 'did:ad:x', jsonAd, snapshot);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('lets an exact caller join a write still in flight, not a settled one', async () => {
    const store = new Store();
    const { db, put, settleAll } = fakeDb();
    void store.persistState(db, 'did:ad:x', jsonAd, snapshot);
    const joined = store.persistState(db, 'did:ad:x', jsonAd, snapshot, {
      exact: true,
    });
    expect(put).toHaveBeenCalledTimes(1);
    await settleAll();
    await joined;

    const again = store.persistState(db, 'did:ad:x', jsonAd, snapshot, {
      exact: true,
    });
    expect(put).toHaveBeenCalledTimes(2);
    await settleAll();
    await again;
  });

  it('writes again to another database or after a change', async () => {
    const store = new Store();
    const a = fakeDb();
    const b = fakeDb();
    void store.persistState(a.db, 'did:ad:x', jsonAd, snapshot);
    void store.persistState(b.db, 'did:ad:x', jsonAd, snapshot);
    void store.persistState(b.db, 'did:ad:x', jsonAd, new Uint8Array([9]));
    expect(a.put).toHaveBeenCalledTimes(1);
    expect(b.put).toHaveBeenCalledTimes(2);
    await a.settleAll();
    await b.settleAll();
  });

  it('forgets a failed write so the next attempt retries', async () => {
    const store = new Store();
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValue(undefined);
    const db = { putResourceWithSnapshot: put } as unknown as ClientDbWorker;
    await expect(
      store.persistState(db, 'did:ad:x', jsonAd, snapshot),
    ).rejects.toThrow('disk');
    await store.persistState(db, 'did:ad:x', jsonAd, snapshot);
    expect(put).toHaveBeenCalledTimes(2);
  });
});
