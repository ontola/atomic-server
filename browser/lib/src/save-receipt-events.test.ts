import { afterEach, expect, it, vi } from 'vitest';
import { StoreEvents } from './store.js';
import { testStore } from './test-store.js';
import type { SaveReceipt } from './resource.js';
import { core } from './ontologies/core.js';

afterEach(() => vi.restoreAllMocks());

it('publishes immutable exact save receipts without allowing observers to fail the save', async () => {
  const { store } = await testStore();
  const resource = await store.newResource({ noParent: true });
  const observed: SaveReceipt[] = [];
  store.on(StoreEvents.SaveReceipt, receipt => {
    observed.push(receipt);
    throw new Error('observer failed');
  });
  const first = await resource.saveWithReceipt();
  await resource.set(core.properties.name, 'Next', false);
  await expect(resource.save()).resolves.toBe('persisted');
  expect(observed).toHaveLength(2);
  expect(observed[0]).toBe(first);
  expect(observed[1].server?.version).not.toBe(first.server?.version);
  expect(Object.isFrozen(observed[0])).toBe(true);
  expect(Object.isFrozen(observed[0].server)).toBe(true);
  store.setServerConnected(false);
});

it.each([false, true])(
  'does not route an in-flight old-database save to a new subscriber (return=%s)',
  async returnToOriginal => {
    const { store, postCommitSpy } = await testStore();
    const resource = await store.newResource({ noParent: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    postCommitSpy.mockImplementationOnce(async commit => {
      await gate;

      return {
        ...commit,
        id: `https://example.com/commits/${commit.signature}`,
      };
    });
    const saving = resource.saveWithReceipt();
    await vi.waitUntil(() => postCommitSpy.mock.calls.length === 1);
    const original = store.getClientDb();
    store.setClientDb({} as NonNullable<ReturnType<typeof store.getClientDb>>);
    if (returnToOriginal) store.setClientDb(original);
    const observed = vi.fn();
    store.on(StoreEvents.SaveReceipt, observed);
    release();
    expect((await saving).server).toBeDefined();
    expect(observed).not.toHaveBeenCalled();
    store.setServerConnected(false);
  },
);
