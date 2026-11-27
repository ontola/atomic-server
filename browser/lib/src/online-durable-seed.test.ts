import { afterEach, expect, it, vi } from 'vitest';
import { ClientDbWorker, type ClientDbOutboxWrite } from './client-db.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { testStore } from './test-store.js';
import { rowFromLoroSnapshot } from './test-client-db-row.js';

/** Script only the worker's storage RPCs; readiness, seed gating, batching and
 * request correlation use the real ClientDbWorker. No OPFS durability claim. */
class StorageWorker {
  onmessage?: (event: { data: unknown }) => void;
  static rows = new Map<string, { jsonAd: string; snapshot: Uint8Array }>();
  static queues = new Map<string, Map<string, string>>();
  static events: string[] = [];
  static failInit = false;
  terminate() {}
  postMessage(message: Record<string, unknown>) {
    if (message.type === 'init' && StorageWorker.failInit) {
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            id: message.id,
            type: 'error',
            message: 'injected worker open failure',
          },
        }),
      );

      return;
    }

    let data: unknown;

    const writeQueue = (write: ClientDbOutboxWrite) => {
      const queue = StorageWorker.queues.get(write.agent) ?? new Map();
      for (const subject of write.deletes) queue.delete(subject);
      for (const { subject, value } of write.puts) queue.set(subject, value);
      StorageWorker.queues.set(write.agent, queue);
    };

    const put = (item: Record<string, unknown>) => {
      const subject = item.subject as string;
      const snapshot = item.snapshot as Uint8Array;
      StorageWorker.rows.set(subject, {
        jsonAd: rowFromLoroSnapshot(
          subject,
          snapshot,
          item.lastCommit as string,
        ),
        snapshot,
      });
      if (item.outbox) writeQueue(item.outbox as ClientDbOutboxWrite);
      StorageWorker.events.push(`durable:${subject}`);
    };

    if (message.type === 'outboxEntries')
      data = [
        ...(StorageWorker.queues.get(message.agent as string)?.values() ?? []),
      ];
    if (message.type === 'outboxWrite')
      writeQueue(message as unknown as ClientDbOutboxWrite);
    if (message.type === 'putLoroSnapshot') put(message);
    if (message.type === 'putLoroSnapshots')
      for (const item of message.items as Record<string, unknown>[]) put(item);
    if (message.type === 'getResourceWithSnapshot')
      data = StorageWorker.rows.get(message.subject as string) ?? {
        jsonAd: null,
        snapshot: null,
      };
    queueMicrotask(() =>
      this.onmessage?.({ data: { id: message.id, type: 'result', data } }),
    );
  }
}

let db: ClientDbWorker | undefined;
let disconnect: (() => void) | undefined;
afterEach(() => {
  disconnect?.();
  db?.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  localStorage.setItem('ws-disconnected', '1');
});

it.each([false, true])(
  'delivers durable saves while unrelated seeding is pending (existing baseline: %s)',
  async existing => {
    StorageWorker.failInit = false;
    StorageWorker.rows.clear();
    StorageWorker.queues.clear();
    StorageWorker.events = [];
    vi.stubGlobal('Worker', StorageWorker);
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage() {}
        close() {}
      },
    );
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn((_name, _options, callback) =>
          Promise.resolve().then(callback),
        ),
      },
    });
    db = new ClientDbWorker('unused-wasm', 'scripted-worker');
    const seed = Promise.withResolvers<void>();
    db.setSeedPromise(seed.promise);
    await db.init('https://example.com');
    expect(db.isOpen).toBe(true);
    expect(db.isReady).toBe(false);

    const { store, postCommitSpy } = await testStore({ connect: false });
    disconnect = () => store.setServerConnected(false);
    const resource = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'New while seeding' },
    });
    if (existing) await resource.save();
    store.setClientDb(db);
    await store.outbox.whenHydrated();

    if (existing) {
      await resource.persistToClientDb(undefined, { required: true });
      await resource.set(core.properties.name, 'Edit while seeding', false);
    }

    postCommitSpy.mockClear();
    StorageWorker.events = [];
    postCommitSpy.mockImplementation(async commit => {
      expect(StorageWorker.rows.has(commit.subject)).toBe(true);
      expect(
        StorageWorker.queues
          .get(store.getAgent()!.subject)
          ?.has(commit.subject),
      ).toBe(true);
      StorageWorker.events.push(`post:${commit.subject}`);

      return {
        ...commit,
        id: `https://example.com/commits/${commit.signature}`,
      };
    });

    try {
      await expect(resource.save()).resolves.toBe('persisted');
      expect(postCommitSpy).toHaveBeenCalled();
      expect(
        StorageWorker.events.indexOf(`durable:${resource.subject}`),
      ).toBeLessThan(StorageWorker.events.indexOf(`post:${resource.subject}`));
      expect(store.outbox.hasPending(resource.subject)).toBe(false);
      expect(db.isReady).toBe(false);
    } finally {
      store.setServerConnected(false);
      seed.resolve();
      await db.waitForReady();
    }
  },
);

it('does not deliver a genesis when the actual worker cannot open its database', async () => {
  vi.useFakeTimers();
  StorageWorker.failInit = true;
  vi.stubGlobal('Worker', StorageWorker);
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      postMessage() {}
      close() {}
    },
  );
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn((_name, _options, callback) =>
        Promise.resolve().then(callback),
      ),
    },
  });
  db = new ClientDbWorker('unused-wasm', 'scripted-worker');
  const initializing = db.init('https://example.com');
  // Exercise the existing election timeout and failure-observation tick.
  await vi.advanceTimersByTimeAsync(2250);
  await initializing;
  expect(db.isOpen).toBe(false);
  expect(db.initError?.message).toBe('injected worker open failure');
  const { store, postCommitSpy } = await testStore({ connect: false });
  disconnect = () => store.setServerConnected(false);
  store.setClientDb(db);
  await store.outbox.whenHydrated();
  const resource = await store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: { [core.properties.name]: 'Cannot open' },
  });
  await expect(resource.save()).rejects.toThrow('injected worker open failure');
  expect(postCommitSpy).not.toHaveBeenCalled();
  expect(store.outbox.hasPending(resource.subject)).toBe(true);
  expect(store.outbox.getEntry(resource.subject)?.signedGenesis).toBeDefined();
});
