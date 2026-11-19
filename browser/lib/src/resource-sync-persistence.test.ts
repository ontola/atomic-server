import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { Resource } from './resource.js';
import type { WSClient } from './websockets.js';
import { LoroLoader } from './loro-loader.js';
import { core } from './ontologies/core.js';
import { testStore } from './test-store.js';
import type { ClientDbWorker } from './client-db.js';
import type {
  ReceiptScope,
  ResourceReceipts,
  ResourceSyncScope,
  SerializedReceipt,
} from './resource-receipts.js';

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function loadedResource(
  store: Store,
  subject = 'https://example.com/item',
  bytes?: Uint8Array,
) {
  const doc = new LoroLoader.Loro.LoroDoc();

  if (!bytes) {
    doc.getMap('properties').set(core.properties.name, 'First');
    doc.getMap('properties').set(core.properties.isA, [core.classes.Folder]);
    doc.commit();
    bytes = doc.export({ mode: 'snapshot' });
  }

  const resource = new Resource(subject);
  resource.importLoroUpdate(bytes, true);
  resource.setStore(store);
  resource.loading = false;
  resource.new = false;
  store.resources.set(subject, resource);

  return resource;
}

function snapshot(resource: Resource) {
  resource.sealPendingEdits();

  return resource.getLoroDoc()!.export({ mode: 'snapshot' });
}

function receipt(resource: Resource, confirmedAt = 123): SerializedReceipt {
  return {
    subject: resource.subject,
    version: Object.fromEntries(resource.getLoroDoc()!.oplogVersion().toJSON()),
    confirmedAt,
  };
}

function memoryDb() {
  const snapshots = new Map<string, Uint8Array>();
  const receipts = new Map<string, SerializedReceipt>();
  const key = (scope: ResourceSyncScope, subject: string) =>
    JSON.stringify([scope.agent, scope.serverUrl, subject]);
  const serverOf = (scope?: ReceiptScope) =>
    scope && 'server' in scope ? scope.server : undefined;
  const getResourceReceipts = vi.fn(
    async (
      subjects: string[],
      scope?: ReceiptScope,
    ): Promise<ResourceReceipts[]> =>
      subjects.map(subject => {
        const server = serverOf(scope);
        const stored = server && receipts.get(key(server, subject));

        return {
          subject,
          snapshot: snapshots.get(subject) ?? null,
          receipts: stored ? [stored] : [],
        };
      }),
  );
  const putResourceReceipts = vi.fn(
    async (scope: ReceiptScope, values: SerializedReceipt[]) => {
      const server = serverOf(scope)!;

      for (const value of values) {
        if (snapshots.has(value.subject))
          receipts.set(key(server, value.subject), structuredClone(value));
      }

      return true;
    },
  );
  const putResourceWithSnapshot = vi.fn(
    async (subject: string, _json: string, bytes?: Uint8Array) => {
      if (bytes) snapshots.set(subject, bytes);
    },
  );
  const db = {
    isReady: true,
    isInitialized: true,
    waitForInit: async () => true,
    putResourceWithSnapshot,
    getResourceReceipts,
    putResourceReceipts,
  } as unknown as ClientDbWorker;

  return {
    db,
    snapshots,
    receipts,
    key,
    getResourceReceipts,
    putResourceReceipts,
    putResourceWithSnapshot,
  };
}

async function scopedStore() {
  const { store } = await testStore({ connect: false });
  store.setServerConnected(false);

  return store;
}

async function persist(store: Store, db: ClientDbWorker, resource: Resource) {
  await store.persistState(
    db,
    resource.subject,
    resource.toClientDbJsonAd()!,
    snapshot(resource),
  );
}

describe('resource sync proof recovery', () => {
  it('keeps the getter pure and batches durable local proof reads without inventing server proof or save time', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const one = loadedResource(store);
    const two = loadedResource(store, 'https://example.com/second');
    memory.snapshots.set(one.subject, snapshot(one));
    memory.snapshots.set(two.subject, snapshot(two));
    store.getResourceCopies(one);
    store.getResourceCopies(two);
    expect(memory.getResourceReceipts).not.toHaveBeenCalled();
    const unsubscribe = [one, two].map(resource =>
      store.subscribeResourceCopies(resource, vi.fn()),
    );
    await vi.waitFor(() =>
      expect(store.getResourceCopies(one).local.state).toBe('confirmed'),
    );
    expect(store.getResourceCopies(two).local.state).toBe('confirmed');
    expect(memory.getResourceReceipts).toHaveBeenCalledTimes(1);
    expect(store.getResourceCopies(one).local.confirmedAt).toBeUndefined();
    expect(store.getResourceCopies(one).server.state).toBe('unknown');
    unsubscribe.forEach(stop => stop());
  });

  it('recovers the scoped exact server version across stores and keeps offline edits pending', async () => {
    const first = await scopedStore();
    const memory = memoryDb();
    first.setClientDb(memory.db);
    const resource = await first.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    // Low-level postCommit is mocked by testStore; this exercises real receipt
    // capture, local writes and diagnostic flush accounting.
    first.setServerConnected(true);
    await resource.save();
    await vi.waitFor(() =>
      expect(first.getSyncStatus().pendingDirtyCount).toBe(0),
    );
    const originalAt = first.getResourceCopies(resource).server.confirmedAt;
    expect(memory.receipts.size).toBeGreaterThan(0);
    const second = await scopedStore();
    second.setAgent(first.getAgent());
    second.setClientDb(memory.db);
    const restored = loadedResource(
      second,
      resource.subject,
      memory.snapshots.get(resource.subject),
    );
    const stop = second.subscribeResourceCopies(restored, vi.fn());
    await vi.waitFor(() =>
      expect(second.getResourceCopies(restored).server.state).toBe('confirmed'),
    );
    expect(second.getResourceCopies(restored).server.confirmedAt).toBe(
      originalAt,
    );
    expect(second.getResourceCopies(restored).local.state).toBe('confirmed');
    await restored.set(core.properties.name, 'Offline edit', false);
    await persist(second, memory.db, restored);
    expect(second.getResourceCopies(restored).server.state).toBe('pending');
    expect(second.getResourceCopies(restored).local.state).toBe('confirmed');
    stop();
  });

  it('keeps receipt flush in reload readiness, settles failures, and retries after the local row is written', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    const flush = deferred<void>();
    memory.putResourceReceipts.mockImplementation(() => flush.promise);
    store.setServerConnected(true);
    await resource.save();
    await vi.waitFor(() =>
      expect(memory.putResourceReceipts).toHaveBeenCalled(),
    );
    expect(store.getSyncStatus().pendingDirtyCount).toBeGreaterThan(0);
    flush.reject(new Error('Receipt storage failed'));
    await vi.waitFor(() =>
      expect(store.getSyncStatus().pendingDirtyCount).toBe(0),
    );
    expect(store.getResourceCopies(resource).server.state).toBe('confirmed');
    memory.putResourceReceipts.mockClear();
    memory.putResourceReceipts.mockResolvedValue(true);
    await store.persistState(
      memory.db,
      resource.subject,
      resource.toClientDbJsonAd()!,
      snapshot(resource),
      { exact: true },
    );
    await vi.waitFor(() =>
      expect(memory.putResourceReceipts).toHaveBeenCalled(),
    );
  });

  it('does not replace newer live confirmations with a delayed read', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const resource = loadedResource(store);
    const previous = {
      subject: resource.subject,
      snapshot: snapshot(resource),
      receipts: [receipt(resource)],
    };
    const read = deferred<ResourceReceipts[]>();
    memory.getResourceReceipts.mockReturnValue(read.promise);
    const stop = store.subscribeResourceCopies(resource, vi.fn());
    await vi.waitFor(() =>
      expect(memory.getResourceReceipts).toHaveBeenCalled(),
    );
    await resource.set(core.properties.name, 'Newer', false);
    await persist(store, memory.db, resource);
    const commit = await resource.signChanges(store.getAgent()!);
    await store.postCommit(commit, 'https://example.com/commit');
    read.resolve([previous]);
    await vi.waitFor(() =>
      expect(store.getResourceCopies(resource).server.state).toBe('confirmed'),
    );
    await Promise.resolve();
    expect(store.getResourceCopies(resource).local.state).toBe('confirmed');
    expect(
      store.getResourceCopies(resource).server.confirmedAt,
    ).toBeGreaterThan(123);
    stop();
  });

  it.each(['identity', 'destination'] as const)(
    'publishes the new %s before mounted subscribers can start recovery',
    async boundary => {
      const store = await scopedStore();
      const memory = memoryDb();
      store.setClientDb(memory.db);
      const resource = loadedResource(store);
      memory.snapshots.set(resource.subject, snapshot(resource));
      const oldScope: ResourceSyncScope = {
        agent: store.getAgent()!.subject.replace(/^did:ad:/, 'atomic:'),
        serverUrl: 'https://example.com',
      };
      memory.receipts.set(
        memory.key(oldScope, resource.subject),
        receipt(resource),
      );
      let switching = false;
      let reentrantStop: (() => void) | undefined;
      const observations: {
        agent: string | undefined;
        serverUrl: string | undefined;
      }[] = [];
      const stop = store.subscribeResourceCopies(resource, () => {
        const status = store.getResourceCopies(resource);
        if (!switching) return;
        observations.push({
          agent: store.getAgent()?.subject,
          serverUrl: status.server.url,
        });
        // A mounted consumer may resubscribe during a status notification.
        // It must not capture old account/destination under the new epoch.
        reentrantStop ??= store.subscribeResourceCopies(resource, () => {
          store.getResourceCopies(resource);
        });
      });
      await vi.waitFor(() =>
        expect(store.getResourceCopies(resource).server.state).toBe(
          'confirmed',
        ),
      );
      memory.getResourceReceipts.mockClear();
      const other = await scopedStore();
      const expectedAgent =
        boundary === 'identity' ? other.getAgent()! : store.getAgent()!;
      const expectedUrl =
        boundary === 'destination'
          ? 'https://other.example'
          : 'https://example.com';
      switching = true;
      if (boundary === 'identity') store.setAgent(expectedAgent);
      else store.setServerUrl(expectedUrl, { connect: false });
      await vi.waitFor(() =>
        expect(memory.getResourceReceipts).toHaveBeenCalled(),
      );
      await Promise.resolve();

      for (const [, scope] of memory.getResourceReceipts.mock.calls) {
        expect(scope).toEqual({
          server: {
            agent: expectedAgent.subject.replace(/^did:ad:/, 'atomic:'),
            serverUrl: expectedUrl,
          },
        });
      }

      expect(observations).toContainEqual({
        agent: expectedAgent.subject,
        serverUrl: expectedUrl,
      });
      expect(
        observations.every(
          value =>
            value.agent === expectedAgent.subject &&
            value.serverUrl === expectedUrl,
        ),
      ).toBe(true);
      expect(store.getResourceCopies(resource).server.state).toBe('unknown');
      stop();
      reentrantStop?.();
    },
  );

  it.each(['database', 'identity', 'destination', 'eviction'] as const)(
    'fences a delayed proof read after %s changes',
    async boundary => {
      const store = await scopedStore();
      const memory = memoryDb();
      store.setClientDb(memory.db);
      const resource = loadedResource(store);
      const read = deferred<ResourceReceipts[]>();
      memory.getResourceReceipts.mockReturnValueOnce(read.promise);
      const stop = store.subscribeResourceCopies(resource, vi.fn());
      await vi.waitFor(() =>
        expect(memory.getResourceReceipts).toHaveBeenCalled(),
      );
      const row = {
        subject: resource.subject,
        snapshot: snapshot(resource),
        receipts: [receipt(resource)],
      };
      stop();
      if (boundary === 'database') store.setClientDb(memoryDb().db);
      if (boundary === 'identity') store.setAgent(undefined);

      if (boundary === 'destination') {
        store.setServerUrl('https://other.example', { connect: false });
        store.setServerUrl('https://example.com', { connect: false });
      }

      if (boundary === 'eviction') store.evictResource(resource.subject);
      read.resolve([row]);
      await Promise.resolve();
      await Promise.resolve();
      expect(store.getResourceCopies(resource).server.state).toBe('unknown');
      expect(store.getResourceCopies(resource).local.state).toBe('unknown');
    },
  );

  it.each(['destination', 'database', 'eviction'] as const)(
    'drops queued receipt writes after %s changes and settles readiness',
    async boundary => {
      const store = await scopedStore();
      const memory = memoryDb();
      store.setClientDb(memory.db);
      const resource = loadedResource(store);
      const socket = {} as WSClient;
      vi.spyOn(store, 'getDefaultWebSocket').mockReturnValue(socket);
      const acknowledge = store.captureServerResourceReceipt(
        socket,
        resource.subject,
        snapshot(resource),
      )!;
      acknowledge();
      expect(store.getSyncStatus().pendingDirtyCount).toBeGreaterThan(0);
      if (boundary === 'destination')
        store.setServerUrl('https://other.example', { connect: false });
      if (boundary === 'database') store.setClientDb(memoryDb().db);
      if (boundary === 'eviction') store.evictResource(resource.subject);
      await vi.waitFor(() =>
        expect(store.getSyncStatus().pendingDirtyCount).toBe(0),
      );
      expect(memory.putResourceReceipts).not.toHaveBeenCalled();
    },
  );

  it('keeps unsupported adapters and missing/corrupt snapshots unconfirmed', async () => {
    const store = await scopedStore();
    const resource = loadedResource(store);
    store.setClientDb({ isReady: true } as ClientDbWorker);
    const oldStop = store.subscribeResourceCopies(resource, vi.fn());
    await Promise.resolve();
    expect(store.getResourceCopies(resource).local.state).toBe('unknown');
    oldStop();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    memory.getResourceReceipts.mockResolvedValue([
      {
        subject: resource.subject,
        snapshot: new Uint8Array([1, 2, 3]),
        receipts: [receipt(resource)],
      },
    ]);
    const stop = store.subscribeResourceCopies(resource, vi.fn());
    await vi.waitFor(() =>
      expect(memory.getResourceReceipts).toHaveBeenCalled(),
    );
    await Promise.resolve();
    expect(store.getResourceCopies(resource).local.state).toBe('unknown');
    expect(store.getResourceCopies(resource).server.state).toBe('unknown');
    stop();
  });

  it('recovers retained durable proof after cache eviction without inheriting the old in-memory entry', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const resource = loadedResource(store);
    const bytes = snapshot(resource);
    memory.getResourceReceipts.mockResolvedValue([
      {
        subject: resource.subject,
        snapshot: bytes,
        receipts: [receipt(resource)],
      },
    ]);
    const stop = store.subscribeResourceCopies(resource, vi.fn());
    await vi.waitFor(() =>
      expect(store.getResourceCopies(resource).server.state).toBe('confirmed'),
    );
    stop();
    store.evictResource(resource.subject);
    expect(store.getResourceCopies(resource).server.state).toBe('unknown');
    const restored = loadedResource(store, resource.subject, bytes);
    const stopAgain = store.subscribeResourceCopies(restored, vi.fn());
    await vi.waitFor(() =>
      expect(store.getResourceCopies(restored).server.state).toBe('confirmed'),
    );
    expect(memory.getResourceReceipts).toHaveBeenCalledTimes(2);
    stopAgain();
  });

  it('reports durable-read failures without creating proof and accepts later successful local persistence', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const resource = loadedResource(store);
    memory.getResourceReceipts.mockRejectedValue(new Error('Flush failed'));
    const stop = store.subscribeResourceCopies(resource, vi.fn());
    await vi.waitFor(() =>
      expect(store.getResourceCopies(resource).local.state).toBe('error'),
    );
    expect(store.getResourceCopies(resource).server.state).toBe('unknown');
    await persist(store, memory.db, resource);
    expect(store.getResourceCopies(resource).local.state).toBe('confirmed');
    stop();
  });

  it('ignores malformed and unrelated receipts and requests the current account scope while recovering valid local snapshots', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const one = loadedResource(store);
    const two = loadedResource(store, 'https://example.com/two');
    memory.getResourceReceipts.mockResolvedValue([
      {
        subject: one.subject,
        snapshot: snapshot(one),
        receipts: [{ ...receipt(one), version: { broken: NaN } }],
      },
      {
        subject: two.subject,
        snapshot: snapshot(two),
        receipts: [receipt(one)],
      },
    ]);
    const stop = [one, two].map(resource =>
      store.subscribeResourceCopies(resource, vi.fn()),
    );
    await vi.waitFor(() =>
      expect(store.getResourceCopies(one).local.state).toBe('confirmed'),
    );
    expect(store.getResourceCopies(one).server.state).toBe('unknown');
    expect(store.getResourceCopies(two).server.state).toBe('unknown');
    const scope = memory.getResourceReceipts.mock.calls[0][1];
    expect(scope && 'server' in scope && scope.server.agent).toBe(
      store.getAgent()?.subject.replace(/^did:ad:/, 'atomic:'),
    );
    stop.forEach(unsubscribe => unsubscribe());
  });
});
