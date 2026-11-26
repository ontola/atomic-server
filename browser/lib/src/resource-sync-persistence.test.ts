import { encodeB64 } from './base64.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { Resource } from './resource.js';
import type { WSClient } from './websockets.js';
import { LoroLoader } from './loro-loader.js';
import { core } from './ontologies/core.js';
import { testStore } from './test-store.js';
import type { ClientDbWorker } from './client-db.js';
import type {
  ResourceSyncEvidence,
  ResourceSyncScope,
  SerializedServerReceipt,
} from './resource-sync-evidence.js';

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

function receipt(
  resource: Resource,
  confirmedAt = 123,
): SerializedServerReceipt {
  return {
    subject: resource.subject,
    version: Object.fromEntries(resource.getLoroDoc()!.oplogVersion().toJSON()),
    confirmedAt,
  };
}

function memoryDb() {
  const snapshots = new Map<string, Uint8Array>();
  const receipts = new Map<string, SerializedServerReceipt>();
  const key = (scope: ResourceSyncScope, subject: string) =>
    JSON.stringify([scope.agent, scope.serverUrl, subject]);
  const getResourceSyncEvidence = vi.fn(
    async (
      subjects: string[],
      scope?: ResourceSyncScope,
    ): Promise<ResourceSyncEvidence[]> =>
      subjects.map(subject => ({
        subject,
        snapshot: snapshots.get(subject) ?? null,
        serverReceipt: scope ? receipts.get(key(scope, subject)) : undefined,
      })),
  );
  const putResourceSyncReceipts = vi.fn(
    async (scope: ResourceSyncScope, values: SerializedServerReceipt[]) => {
      for (const value of values) {
        if (snapshots.has(value.subject))
          receipts.set(key(scope, value.subject), structuredClone(value));
      }
    },
  );
  const putResourceWithSnapshot = vi.fn(
    async (subject: string, _json: string, bytes?: Uint8Array) => {
      if (bytes) snapshots.set(subject, bytes);
    },
  );
  const db = {
    isReady: true,
    supportsDurablePersistence: true,
    isInitialized: true,
    waitForInit: async () => true,
    putResourceWithSnapshot,
    putLoroSnapshot: vi.fn(async (subject: string, bytes: Uint8Array) => {
      snapshots.set(subject, bytes);
    }),
    getResourceSyncEvidence,
    putResourceSyncReceipts,
    getResourceWithSnapshot: async (subject: string) => ({
      jsonAd: null,
      snapshot: snapshots.get(subject) ?? null,
    }),
  } as unknown as ClientDbWorker;

  return {
    db,
    snapshots,
    receipts,
    key,
    getResourceSyncEvidence,
    putResourceSyncReceipts,
    putResourceWithSnapshot,
  };
}

async function scopedStore() {
  const { store } = await testStore({ connect: false });
  store.setServerConnected(false);

  return store;
}

async function persist(store: Store, db: ClientDbWorker, resource: Resource) {
  await store.persistState(db, resource.subject, {
    kind: 'loro',
    snapshot: snapshot(resource),
  });
}

describe('resource sync proof recovery', () => {
  it('restores a stored server boundary offline without upgrading legacy acceptance', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const resource = loadedResource(store);
    await persist(store, memory.db, resource);
    const emit = (client: Store, target: Resource) =>
      client.notifyServerReplicaReceipt({
        drive: 'https://example.com/drive',
        endpoint: 'https://example.com/storage-receipt',
        serverOrigin: 'https://example.com',
        transport: 'http',
        clientAgent: client.getAgent()!.subject!,
        connectionId: 'test',
        identityGeneration: client.getIdentityGeneration(),
        databaseGeneration: client.getClientDbGeneration(),
        observation: {
          provider: 'server',
          capability: 'supported',
          replica: { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) },
          barrier: {
            subject: target.subject,
            version: encodeB64(target.getLoroDoc()!.oplogVersion().encode()),
            name: 'atomic-redb-flush-v1',
            storage: 'persistent',
            state: 'completed',
          },
        },
      });
    emit(store, resource);
    await vi.waitFor(() =>
      expect(memory.putResourceSyncReceipts).toHaveBeenCalled(),
    );
    const cold = await scopedStore();
    cold.setAgent(store.getAgent());
    cold.setClientDb(memory.db);
    const restored = loadedResource(cold, resource.subject, snapshot(resource));
    const stop = cold.subscribeResourceSyncStatus(restored, () => {});
    await vi.waitFor(() =>
      expect(cold.getResourceSyncStatus(restored).server.stored).toBe(
        'confirmed',
      ),
    );
    // A later receipt in the same incarnation must replace the recovered
    // version when it is persisted again, not reuse fields from the old row.
    const remote = new LoroLoader.Loro.LoroDoc();
    remote.import(snapshot(restored));
    remote.getMap('properties').set(core.properties.name, 'Second version');
    remote.commit();
    restored.importLoroUpdate(remote.export({ mode: 'snapshot' }), true);
    await persist(cold, memory.db, restored);
    emit(cold, restored);
    const expected = Object.fromEntries(remote.oplogVersion().toJSON());
    await vi.waitFor(() =>
      expect([...memory.receipts.values()][0].stored?.version).toEqual(
        expected,
      ),
    );
    stop();
  });

  it('keeps the getter pure and batches durable local proof reads without inventing server proof or save time', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const one = loadedResource(store);
    const two = loadedResource(store, 'https://example.com/second');
    memory.snapshots.set(one.subject, snapshot(one));
    memory.snapshots.set(two.subject, snapshot(two));
    store.getResourceSyncStatus(one);
    store.getResourceSyncStatus(two);
    expect(memory.getResourceSyncEvidence).not.toHaveBeenCalled();
    const unsubscribe = [one, two].map(resource =>
      store.subscribeResourceSyncStatus(resource, vi.fn()),
    );
    await vi.waitFor(() =>
      expect(store.getResourceSyncStatus(one).local.state).toBe('confirmed'),
    );
    expect(store.getResourceSyncStatus(two).local.state).toBe('confirmed');
    expect(memory.getResourceSyncEvidence).toHaveBeenCalledTimes(1);
    expect(store.getResourceSyncStatus(one).local.confirmedAt).toBeUndefined();
    expect(store.getResourceSyncStatus(one).server.state).toBe('unknown');
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
    const originalAt = first.getResourceSyncStatus(resource).server.confirmedAt;
    expect(memory.receipts.size).toBeGreaterThan(0);
    const second = await scopedStore();
    second.setAgent(first.getAgent());
    second.setClientDb(memory.db);
    const restored = loadedResource(
      second,
      resource.subject,
      memory.snapshots.get(resource.subject),
    );
    const stop = second.subscribeResourceSyncStatus(restored, vi.fn());
    await vi.waitFor(() =>
      expect(second.getResourceSyncStatus(restored).server.state).toBe(
        'confirmed',
      ),
    );
    expect(second.getResourceSyncStatus(restored).server.confirmedAt).toBe(
      originalAt,
    );
    expect(second.getResourceSyncStatus(restored).local.state).toBe(
      'confirmed',
    );
    await restored.set(core.properties.name, 'Offline edit', false);
    await persist(second, memory.db, restored);
    expect(second.getResourceSyncStatus(restored).server.state).toBe('pending');
    expect(second.getResourceSyncStatus(restored).local.state).toBe(
      'confirmed',
    );
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
    memory.putResourceSyncReceipts.mockImplementation(() => flush.promise);
    store.setServerConnected(true);
    await resource.save();
    await vi.waitFor(() =>
      expect(memory.putResourceSyncReceipts).toHaveBeenCalled(),
    );
    expect(store.getSyncStatus().pendingDirtyCount).toBeGreaterThan(0);
    flush.reject(new Error('Receipt storage failed'));
    await vi.waitFor(() =>
      expect(store.getSyncStatus().pendingDirtyCount).toBe(0),
    );
    expect(store.getResourceSyncStatus(resource).server.state).toBe(
      'confirmed',
    );
    memory.putResourceSyncReceipts.mockClear();
    memory.putResourceSyncReceipts.mockResolvedValue(undefined);
    await store.persistState(
      memory.db,
      resource.subject,
      { kind: 'loro', snapshot: snapshot(resource) },
      { exact: true },
    );
    await vi.waitFor(() =>
      expect(memory.putResourceSyncReceipts).toHaveBeenCalled(),
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
      serverReceipt: receipt(resource),
    };
    const read = deferred<ResourceSyncEvidence[]>();
    memory.getResourceSyncEvidence.mockReturnValue(read.promise);
    const stop = store.subscribeResourceSyncStatus(resource, vi.fn());
    await vi.waitFor(() =>
      expect(memory.getResourceSyncEvidence).toHaveBeenCalled(),
    );
    await resource.set(core.properties.name, 'Newer', false);
    await persist(store, memory.db, resource);
    const commit = await resource.signChanges(store.getAgent()!);
    await store.postCommit(commit, 'https://example.com/commit');
    read.resolve([previous]);
    await vi.waitFor(() =>
      expect(store.getResourceSyncStatus(resource).server.state).toBe(
        'confirmed',
      ),
    );
    await Promise.resolve();
    expect(store.getResourceSyncStatus(resource).local.state).toBe('confirmed');
    expect(
      store.getResourceSyncStatus(resource).server.confirmedAt,
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
      const stop = store.subscribeResourceSyncStatus(resource, () => {
        const status = store.getResourceSyncStatus(resource);
        if (!switching) return;
        observations.push({
          agent: store.getAgent()?.subject,
          serverUrl: status.server.url,
        });
        // A mounted consumer may resubscribe during a status notification.
        // It must not capture old account/destination under the new epoch.
        reentrantStop ??= store.subscribeResourceSyncStatus(resource, () => {
          store.getResourceSyncStatus(resource);
        });
      });
      await vi.waitFor(() =>
        expect(store.getResourceSyncStatus(resource).server.state).toBe(
          'confirmed',
        ),
      );
      memory.getResourceSyncEvidence.mockClear();
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
        expect(memory.getResourceSyncEvidence).toHaveBeenCalled(),
      );
      await Promise.resolve();

      for (const [, scope] of memory.getResourceSyncEvidence.mock.calls) {
        expect(scope).toEqual({
          agent: expectedAgent.subject.replace(/^did:ad:/, 'atomic:'),
          serverUrl: expectedUrl,
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
      expect(store.getResourceSyncStatus(resource).server.state).toBe(
        'unknown',
      );
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
      const read = deferred<ResourceSyncEvidence[]>();
      memory.getResourceSyncEvidence.mockReturnValueOnce(read.promise);
      const stop = store.subscribeResourceSyncStatus(resource, vi.fn());
      await vi.waitFor(() =>
        expect(memory.getResourceSyncEvidence).toHaveBeenCalled(),
      );
      const row = {
        subject: resource.subject,
        snapshot: snapshot(resource),
        serverReceipt: receipt(resource),
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
      expect(store.getResourceSyncStatus(resource).server.state).toBe(
        'unknown',
      );
      expect(store.getResourceSyncStatus(resource).local.state).toBe('unknown');
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
      expect(memory.putResourceSyncReceipts).not.toHaveBeenCalled();
    },
  );

  it('keeps unsupported adapters and missing/corrupt snapshots unconfirmed', async () => {
    const store = await scopedStore();
    const resource = loadedResource(store);
    store.setClientDb({ isReady: true } as ClientDbWorker);
    const oldStop = store.subscribeResourceSyncStatus(resource, vi.fn());
    await Promise.resolve();
    expect(store.getResourceSyncStatus(resource).local.state).toBe(
      'unavailable',
    );
    oldStop();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    memory.getResourceSyncEvidence.mockResolvedValue([
      {
        subject: resource.subject,
        snapshot: new Uint8Array([1, 2, 3]),
        serverReceipt: receipt(resource),
      },
    ]);
    const stop = store.subscribeResourceSyncStatus(resource, vi.fn());
    await vi.waitFor(() =>
      expect(memory.getResourceSyncEvidence).toHaveBeenCalled(),
    );
    await Promise.resolve();
    expect(store.getResourceSyncStatus(resource).local.state).toBe('unknown');
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
    stop();
  });

  it('recovers retained durable proof after cache eviction without inheriting the old in-memory entry', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const resource = loadedResource(store);
    const bytes = snapshot(resource);
    memory.getResourceSyncEvidence.mockResolvedValue([
      {
        subject: resource.subject,
        snapshot: bytes,
        serverReceipt: receipt(resource),
      },
    ]);
    const stop = store.subscribeResourceSyncStatus(resource, vi.fn());
    await vi.waitFor(() =>
      expect(store.getResourceSyncStatus(resource).server.state).toBe(
        'confirmed',
      ),
    );
    stop();
    store.evictResource(resource.subject);
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
    const restored = loadedResource(store, resource.subject, bytes);
    const stopAgain = store.subscribeResourceSyncStatus(restored, vi.fn());
    await vi.waitFor(() =>
      expect(store.getResourceSyncStatus(restored).server.state).toBe(
        'confirmed',
      ),
    );
    expect(memory.getResourceSyncEvidence).toHaveBeenCalledTimes(2);
    stopAgain();
  });

  it('reports durable-read failures without creating proof and accepts later successful local persistence', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const resource = loadedResource(store);
    memory.getResourceSyncEvidence.mockRejectedValue(new Error('Flush failed'));
    const stop = store.subscribeResourceSyncStatus(resource, vi.fn());
    await vi.waitFor(() =>
      expect(store.getResourceSyncStatus(resource).local.state).toBe('error'),
    );
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
    await persist(store, memory.db, resource);
    expect(store.getResourceSyncStatus(resource).local.state).toBe('confirmed');
    stop();
  });

  it('ignores malformed and unrelated receipts and requests the current account scope while recovering valid local snapshots', async () => {
    const store = await scopedStore();
    const memory = memoryDb();
    store.setClientDb(memory.db);
    const one = loadedResource(store);
    const two = loadedResource(store, 'https://example.com/two');
    memory.getResourceSyncEvidence.mockResolvedValue([
      {
        subject: one.subject,
        snapshot: snapshot(one),
        serverReceipt: { ...receipt(one), version: { broken: NaN } },
      },
      {
        subject: two.subject,
        snapshot: snapshot(two),
        serverReceipt: receipt(one),
      },
    ]);
    const stop = [one, two].map(resource =>
      store.subscribeResourceSyncStatus(resource, vi.fn()),
    );
    await vi.waitFor(() =>
      expect(store.getResourceSyncStatus(one).local.state).toBe('confirmed'),
    );
    expect(store.getResourceSyncStatus(one).server.state).toBe('unknown');
    expect(store.getResourceSyncStatus(two).server.state).toBe('unknown');
    const scope = memory.getResourceSyncEvidence.mock.calls[0][1];
    expect(scope?.agent).toBe(
      store.getAgent()?.subject.replace(/^did:ad:/, 'atomic:'),
    );
    stop.forEach(unsubscribe => unsubscribe());
  });
});
