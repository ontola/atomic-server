import { encodeB64 } from './base64.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Resource } from './resource.js';
import { Store } from './store.js';
import { testStore } from './test-store.js';
import { LoroLoader } from './loro-loader.js';
import { core } from './ontologies/core.js';
import type { ClientDbWorker } from './client-db.js';
import type { Commit } from './commit.js';

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

function localResource(store: Store, subject = 'https://example.com/resource') {
  const resource = new Resource(subject);
  resource.setStore(store);
  resource
    .getLoroDoc()!
    .getMap('properties')
    .set(core.properties.name, 'First');
  resource.sealPendingEdits();

  return resource;
}

function snapshot(resource: Resource) {
  return resource.getLoroDoc()!.export({ mode: 'snapshot' });
}

function database(put = vi.fn(async () => {})) {
  return {
    isReady: true,
    supportsDurablePersistence: true,
    waitForInit: async () => true,
    getResourcesWithSnapshots: async (subjects: string[]) =>
      subjects.map(() => ({ jsonAd: null, snapshot: null })),
    putResourceWithSnapshot: put,
    putLoroSnapshot: put,
  } as unknown as ClientDbWorker;
}

describe('resource copy evidence', () => {
  it('shares one copy watch and batches updates until the last observer leaves', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const resource = localResource(store);
    const stopMetadata = vi.fn();
    const stopAttachments = vi.fn();
    const metadata = vi
      .spyOn(store, 'subscribeResourceSyncStatus')
      .mockReturnValue(stopMetadata);
    const attachments = vi
      .spyOn(store, 'subscribeResourceAttachmentSyncStatus')
      .mockReturnValue(stopAttachments);
    const callback = vi.fn();
    const stopFirst = store.subscribeResourceCopies(resource, callback);
    const stopSecond = store.subscribeResourceCopies(resource, callback);

    expect(metadata).toHaveBeenCalledTimes(1);
    expect(attachments).toHaveBeenCalledTimes(1);
    const changed = metadata.mock.calls[0][1];
    changed();
    attachments.mock.calls[0][1]();
    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(2);

    stopFirst();
    stopFirst();
    changed();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(3);
    expect(stopMetadata).not.toHaveBeenCalled();
    expect(stopAttachments).not.toHaveBeenCalled();

    changed();
    stopSecond();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(3);
    expect(stopMetadata).toHaveBeenCalledOnce();
    expect(stopAttachments).toHaveBeenCalledOnce();
  });

  it('requires an actual server barrier and fences generations per drive', async () => {
    const { store } = await testStore();
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    await resource.save();
    const accepted = store.getResourceCopies(resource);
    expect(store.getResourceCopies(resource)).toBe(accepted);
    expect(accepted.status.server).toMatchObject({
      accepted: 'confirmed',
      stored: 'unknown',
    });
    const emit = (
      target: Resource,
      drive: string,
      generation = 'b'.repeat(64),
    ) =>
      store.notifyServerReplicaReceipt({
        drive,
        endpoint: 'https://example.com/storage-receipt',
        serverOrigin: 'https://example.com',
        transport: 'http',
        clientAgent: store.getAgent()!.subject!,
        identityGeneration: store.getIdentityGeneration(),
        databaseGeneration: store.getClientDbGeneration(),
        connectionId: 'test-session',
        observation: {
          provider: 'test',
          capability: 'supported',
          replica: { storageId: 'a'.repeat(64), generation },
          barrier: {
            subject: target.subject,
            version: encodeB64(target.getLoroDoc()!.oplogVersion().encode()),
            name: 'atomic-redb-flush-v1',
            storage: 'persistent',
            state: 'completed',
          },
        },
      });
    emit(resource, resource.subject);
    const stored = store.getResourceCopies(resource);
    expect(stored).not.toBe(accepted);
    expect(stored.status.server.stored).toBe('confirmed');
    store.setServerConnected(false);
    expect(store.getResourceSyncStatus(resource).server.stored).toBe(
      'confirmed',
    );
    const other = localResource(store, 'https://example.com/other');
    emit(other, 'https://example.com/other-drive', 'c'.repeat(64));
    expect(store.getResourceSyncStatus(resource).server.stored).toBe(
      'confirmed',
    );
    emit(other, resource.subject, 'd'.repeat(64));
    expect(store.getResourceSyncStatus(resource).server.stored).toBe('unknown');
    emit(resource, resource.subject, 'd'.repeat(64));
    resource
      .getLoroDoc()!
      .getMap('properties')
      .set(core.properties.name, 'New edit');
    resource.sealPendingEdits();
    expect(store.getResourceSyncStatus(resource).server.stored).toBe('pending');
  });

  it('never labels a memory adapter write as persistent local storage', async () => {
    const { store } = await testStore();
    const resource = localResource(store);
    const db = {
      ...database(),
      supportsDurablePersistence: false,
    } as ClientDbWorker;
    store.setClientDb(db);
    await store.persistState(db, resource.subject, {
      kind: 'loro',
      snapshot: snapshot(resource),
    });
    expect(store.getResourceSyncStatus(resource).local.state).toBe(
      'unavailable',
    );
  });

  it('persists server metadata carried by a deduplicated own commit echo without notifying resource consumers', async () => {
    const { store } = await testStore();
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    await resource.save();
    const db = database();
    store.setClientDb(db);
    resource.appliedCommitSignatures.add('own-signature');
    store.resources.set(resource.subject, resource);
    await store.persistState(db, resource.subject, {
      kind: 'loro',
      snapshot: snapshot(resource),
    });
    const remote = new LoroLoader.Loro.LoroDoc();
    remote.import(snapshot(resource));
    remote
      .getMap('properties')
      .set(core.properties.description, 'Server metadata');
    remote.commit();
    const changed = vi.fn();
    const unsubscribe = store.subscribe(resource.subject, changed);
    expect(
      store.applyIncoming({
        subject: resource.subject,
        loroBytes: remote.export({ mode: 'snapshot' }),
        commitId: 'atomic:commit:own-signature',
        source: 'ws-sub-push',
      }),
    ).toBe('deduped');
    await vi.waitFor(() =>
      expect(store.getResourceSyncStatus(resource).local.state).toBe(
        'confirmed',
      ),
    );
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not infer a resource receipt from a connected server or a finished drive sync', () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const resource = localResource(store);
    store.setServerConnected(true);
    store.finishDriveSync(resource.subject, 1, Date.now());

    const status = store.getResourceSyncStatus(resource);
    expect(status.local.state).toBe('unavailable');
    expect(status.server.state).toBe('unknown');
    expect(store.getResourceSyncStatus(resource)).toBe(status);
  });

  it('confirms the exact acknowledged version, retains it offline, and excludes another resource', async () => {
    const { store } = await testStore();
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    await resource.save();
    expect(store.getResourceSyncStatus(resource).server.state).toBe(
      'confirmed',
    );
    store.setServerConnected(false);
    expect(store.getResourceSyncStatus(resource).server.state).toBe(
      'confirmed',
    );
    expect(store.getResourceSyncStatus(localResource(store)).server.state).toBe(
      'unknown',
    );

    await resource.set(core.properties.name, 'New edit', false);
    expect(store.getResourceSyncStatus(resource).server.state).toBe('pending');
  });

  it('an acknowledgement arriving during an edit does not confirm the newer edit', async () => {
    const { store, postCommitSpy } = await testStore();
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    await resource.save();
    await resource.set(core.properties.name, 'Sent', false);
    const commit = await resource.signChanges(store.getAgent()!);
    const response = deferred<Commit>();
    postCommitSpy.mockReturnValueOnce(response.promise);
    const sending = store.postCommit(commit, 'https://example.com/commit');
    await resource.set(core.properties.name, 'Typed during send', false);
    response.resolve(commit);
    await sending;
    expect(store.getResourceSyncStatus(resource).server.state).toBe('pending');
    store.setServerConnected(false);
  });

  it('refusals, foreign endpoints and custom host transports are not server receipts', async () => {
    const { store, postCommitSpy } = await testStore();
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    const commit = await resource.signChanges(store.getAgent()!);
    postCommitSpy.mockRejectedValueOnce(new Error('Refused'));
    await expect(
      store.postCommit(commit, 'https://example.com/commit'),
    ).rejects.toThrow('Refused');
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
    await store.postCommit(commit, 'https://other.example/commit');
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
    store.setServerConnected(false);
    store.setCommitTransport(async value => value);
    await store.postCommit(commit, 'https://example.com/commit');
    expect(store.getResourceSyncStatus(resource).server.state).toBe(
      'not-configured',
    );
    store.setCommitTransport(undefined);
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
  });

  it('does not reuse receipts or delayed acknowledgements after a destination or identity change', async () => {
    const { store, postCommitSpy } = await testStore();
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    await resource.save();
    const receipt = store.getResourceSyncStatus(resource);
    expect(receipt.server.state).toBe('confirmed');
    await resource.set(core.properties.name, 'Waiting', false);
    const commit = await resource.signChanges(store.getAgent()!);
    const response = deferred<Commit>();
    postCommitSpy.mockReturnValueOnce(response.promise);
    const sending = store.postCommit(commit, 'https://example.com/commit');
    store.setServerUrl('https://other.example', { connect: false });
    store.setServerUrl('https://example.com', { connect: false });
    response.resolve(commit);
    await sending;
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');

    await store.postCommit(commit, 'https://example.com/commit');
    expect(store.getResourceSyncStatus(resource).server.state).toBe(
      'confirmed',
    );
    store.setAgent(undefined);
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
    store.setServerConnected(false);
  });

  it('notifies subscribers after database/transport changes and same-worker initialization failures', () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const resource = localResource(store);
    const observed: ReturnType<Store['getResourceSyncStatus']>[] = [];
    const unsubscribe = store.subscribeResourceSyncStatus(resource, () => {
      observed.push(store.getResourceSyncStatus(resource));
    });
    const db = database();
    store.setClientDb(db);
    expect(observed[0].local.state).toBe('unknown');
    observed.length = 0;
    store.setCommitTransport(async commit => commit);
    expect(observed[0].server.state).toBe('not-configured');
    observed.length = 0;
    // The database reports initialization success/failure by mutating and
    // reattaching the same worker. This must notify without clearing receipts.
    Object.assign(db, {
      initError: new Error('Browser storage could not open'),
    });
    store.setClientDb(db);
    expect(observed.at(-1)?.local.state).toBe('error');
    expect(observed.at(-1)?.local.error).toBe('Browser storage could not open');
    unsubscribe();
  });

  it('waits for the local durable write and notifies subscribers on its completion', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const write = deferred<void>();
    const db = database(vi.fn(() => write.promise));
    store.setClientDb(db);
    const resource = localResource(store);
    const changed = vi.fn();
    const unsubscribe = store.subscribeResourceSyncStatus(resource, changed);
    const pending = store.persistState(db, resource.subject, {
      kind: 'loro',
      snapshot: snapshot(resource),
    });
    expect(store.getResourceSyncStatus(resource).local.state).toBe('pending');
    changed.mockClear();
    write.resolve();
    await pending;
    expect(changed).toHaveBeenCalled();
    expect(store.getResourceSyncStatus(resource).local.state).toBe('confirmed');
    unsubscribe();
  });

  it('does not mark newer edits as locally saved when an older snapshot finishes', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const write = deferred<void>();
    const db = database(vi.fn(() => write.promise));
    store.setClientDb(db);
    const resource = localResource(store);
    const pending = store.persistState(db, resource.subject, {
      kind: 'loro',
      snapshot: snapshot(resource),
    });
    resource
      .getLoroDoc()!
      .getMap('properties')
      .set(core.properties.name, 'Second');
    resource.sealPendingEdits();
    write.resolve();
    await pending;
    expect(store.getResourceSyncStatus(resource).local.state).toBe('pending');
  });

  it('shows local write failures without manufacturing a saved copy', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const write = deferred<void>();
    const db = database(vi.fn(() => write.promise));
    store.setClientDb(db);
    const resource = localResource(store);
    const pending = store.persistState(db, resource.subject, {
      kind: 'loro',
      snapshot: snapshot(resource),
    });
    write.reject(new Error('Disk unavailable'));
    await expect(pending).rejects.toThrow('Disk unavailable');
    expect(store.getResourceSyncStatus(resource).local).toMatchObject({
      state: 'error',
      error: 'Disk unavailable',
    });
  });

  it('ignores completion by a replaced database and normalizes legacy identifiers', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const write = deferred<void>();
    const db = database(vi.fn(() => write.promise));
    store.setClientDb(db);
    const resource = localResource(store, 'atomic:test-resource');
    const pending = store.persistState(db, 'did:ad:test-resource', {
      kind: 'loro',
      snapshot: snapshot(resource),
    });
    write.resolve();
    await pending;
    expect(store.getResourceSyncStatus(resource).local.state).toBe('confirmed');

    const later = deferred<void>();
    vi.mocked(db.putLoroSnapshot).mockImplementationOnce(() => later.promise);
    const pendingLater = store.persistState(
      db,
      resource.subject,
      { kind: 'loro', snapshot: snapshot(resource) },
      { exact: true },
    );
    store.setClientDb(database());
    later.resolve();
    await pendingLater;
    expect(store.getResourceSyncStatus(resource).local.state).toBe('unknown');
  });
  it('follows subject renaming and isolates subscribers from the durable write', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const write = deferred<void>();
    const db = database(vi.fn(() => write.promise));
    store.setClientDb(db);
    const resource = localResource(store);
    const changed = vi.fn();
    const unsubscribe = store.subscribeResourceSyncStatus(resource, changed);
    const stopThrowing = store.subscribeResourceSyncStatus(resource, () => {
      throw new Error('subscriber broke');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    resource.setSubject('https://example.com/renamed');
    const pending = store.persistState(db, resource.subject, {
      kind: 'loro',
      snapshot: snapshot(resource),
    });
    changed.mockClear();
    write.resolve();
    await pending;
    expect(changed).toHaveBeenCalled();
    expect(store.getResourceSyncStatus(resource).local.state).toBe('confirmed');
    expect(log).toHaveBeenCalled();
    stopThrowing();
    unsubscribe();
  });

  it('eviction invalidates an in-flight server receipt', async () => {
    const { store, postCommitSpy } = await testStore();
    const resource = await store.newResource({
      isA: core.classes.Drive,
      noParent: true,
    });
    const commit = await resource.signChanges(store.getAgent()!);
    const response = deferred<Commit>();
    postCommitSpy.mockReturnValueOnce(response.promise);
    const sending = store.postCommit(commit, 'https://example.com/commit');
    store.evictResource(resource.subject);
    response.resolve(commit);
    await sending;
    expect(store.getResourceSyncStatus(resource).server.state).toBe('unknown');
    store.setServerConnected(false);
  });
});
