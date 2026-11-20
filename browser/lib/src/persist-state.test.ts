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
    db: { putLoroSnapshot: put } as unknown as ClientDbWorker,
    put,
    settleAll: async () => {
      writes.splice(0).forEach(resolve => resolve());
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('Store.persistState', () => {
  const row = (snapshot: Uint8Array, lastCommit?: string) =>
    ({ kind: 'loro', snapshot, lastCommit }) as const;
  const snapshot = new Uint8Array([1, 2, 3]);

  it('writes an unchanged state once', async () => {
    const store = new Store();
    const { db, put, settleAll } = fakeDb();
    const first = store.persistState(db, 'did:ad:x', row(snapshot));
    const second = store.persistState(db, 'did:ad:x', row(snapshot));
    await settleAll();
    await Promise.all([first, second]);
    await store.persistState(db, 'did:ad:x', row(snapshot));
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('lets an exact caller join a write still in flight, not a settled one', async () => {
    const store = new Store();
    const { db, put, settleAll } = fakeDb();
    void store.persistState(db, 'did:ad:x', row(snapshot));
    const joined = store.persistState(db, 'did:ad:x', row(snapshot), {
      exact: true,
    });
    expect(put).toHaveBeenCalledTimes(1);
    await settleAll();
    await joined;

    const again = store.persistState(db, 'did:ad:x', row(snapshot), {
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
    void store.persistState(a.db, 'did:ad:x', row(snapshot));
    void store.persistState(b.db, 'did:ad:x', row(snapshot));
    void store.persistState(b.db, 'did:ad:x', row(new Uint8Array([9])));
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
    const db = { putLoroSnapshot: put } as unknown as ClientDbWorker;
    await expect(
      store.persistState(db, 'did:ad:x', row(snapshot)),
    ).rejects.toThrow('disk');
    await store.persistState(db, 'did:ad:x', row(snapshot));
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('Store.persistState row kinds', () => {
  it('writes a changed lastCommit, and a JSON-AD row through the old method', async () => {
    const store = new Store();
    const loro = vi.fn().mockResolvedValue(undefined);
    const json = vi.fn().mockResolvedValue(undefined);
    const db = {
      putLoroSnapshot: loro,
      putResourceWithSnapshot: json,
    } as unknown as ClientDbWorker;
    const snapshot = new Uint8Array([1, 2, 3]);

    await store.persistState(db, 's', {
      kind: 'loro',
      snapshot,
      lastCommit: 'a',
    });
    await store.persistState(db, 's', {
      kind: 'loro',
      snapshot,
      lastCommit: 'a',
    });
    await store.persistState(db, 's', {
      kind: 'loro',
      snapshot,
      lastCommit: 'b',
    });
    expect(loro).toHaveBeenCalledTimes(2);
    expect(loro).toHaveBeenLastCalledWith('s', snapshot, 'b', undefined);

    await store.persistState(db, 'c', {
      kind: 'jsonAd',
      jsonAd: '{"@id":"c"}',
    });
    expect(json).toHaveBeenCalledWith('c', '{"@id":"c"}', undefined, undefined);
  });
});
