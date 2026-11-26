import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockLocalPersistence, testStore } from './test-store.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { encodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import type { Commit } from './commit.js';
import { commitSubject } from './subject.js';
import type { Store } from './store.js';
import { Resource, SaveQueuedError } from './resource.js';

afterEach(() => vi.restoreAllMocks());

function durableWrites(store: Store) {
  const write = mockLocalPersistence(store);

  return write;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));

  return { promise, resolve };
}

async function document(localOnly = false) {
  const context = await testStore();
  const resource = await context.store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: { [core.properties.name]: 'First' },
  });
  if (localOnly) context.store.registerLocalOnlyDrive(resource.subject);

  return { ...context, resource };
}

function snapshotVersion(snapshot: Uint8Array) {
  const doc = new LoroLoader.Loro.LoroDoc();
  doc.import(snapshot);

  return encodeB64(doc.oplogVersion().encode());
}

describe('save receipts', () => {
  it('reports the exact local snapshot, excluding edits during the write', async () => {
    const { store, resource } = await document(true);
    const write = durableWrites(store);
    const gate = deferred<void>();
    write.mockReturnValueOnce(gate.promise);
    const saving = resource.saveWithReceipt();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const expected = snapshotVersion(write.mock.calls[0][2]!);
    await resource.set(core.properties.name, 'Later', false);
    gate.resolve();

    const receipt = await saving;
    expect(receipt).toEqual({
      status: 'persisted',
      subject: resource.subject,
      local: { version: expected },
    });
    expect(resource.hasUnsavedChanges()).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.local)).toBe(true);
  });

  it('identifies the accepted genesis and its captured destination', async () => {
    const { store, resource, postCommitSpy } = await document();
    const original = postCommitSpy.getMockImplementation()!;
    postCommitSpy.mockImplementationOnce(async (commit: Commit) => {
      store.setServerUrl('https://other.example');

      return original(commit);
    });
    const receipt = await resource.saveWithReceipt();
    const sent = postCommitSpy.mock.calls[0][0] as Commit;
    expect(receipt.server).toEqual({
      endpoint: 'https://example.com/commit',
      commit: commitSubject(sent.signature),
      version: snapshotVersion(sent.loroUpdate!),
    });
    expect(receipt.local).toBeUndefined();
    expect(Object.isFrozen(receipt.server)).toBe(true);
    store.setServerConnected(false);
  });

  it('does not reuse evidence on a no-op or a child waiting for its parent', async () => {
    const { store, resource } = await document();
    await resource.saveWithReceipt();
    expect(await resource.saveWithReceipt()).toEqual({
      status: 'noop',
      subject: resource.subject,
    });
    const parent = await store.newResource({ noParent: true });
    parent.new = true;
    const child = await store.newResource({ parent: parent.subject });
    await child.set(core.properties.name, 'Waiting', false);
    const receipt = await child.saveWithReceipt();
    expect(receipt.local).toBeUndefined();
    expect(receipt.server).toBeUndefined();
    store.setServerConnected(false);
  });

  it('serializes concurrent callers without sharing the first receipt', async () => {
    const { store, resource, postCommitSpy } = await document();
    const gate = deferred<Commit>();
    postCommitSpy.mockReturnValueOnce(gate.promise);
    const first = resource.saveWithReceipt();
    await vi.waitFor(() => expect(postCommitSpy).toHaveBeenCalledTimes(1));
    const second = resource.saveWithReceipt();
    const sent = postCommitSpy.mock.calls[0][0] as Commit;
    gate.resolve(sent);
    expect((await first).server).toBeDefined();
    expect(await second).toEqual({ status: 'noop', subject: resource.subject });
    expect(postCommitSpy).toHaveBeenCalledTimes(1);
    store.setServerConnected(false);
  });

  it('does not attach a background acknowledgement to a subscriber-started no-op', async () => {
    const { store, resource } = await document();
    await resource.save();
    await resource.set(core.properties.name, 'Background edit', false);
    resource.getLoroDoc()!.commit();
    let noop: ReturnType<Resource['saveWithReceipt']> | undefined;
    const unsubscribe = store.subscribe(resource.subject, () => {
      if (
        !noop &&
        !resource.hasUnsavedChanges() &&
        !store.outbox.hasPending(resource.subject)
      ) {
        noop = resource.saveWithReceipt();
      }
    });
    await store.syncDirtyResources();
    expect(noop).toBeDefined();
    expect(await noop).toEqual({ status: 'noop', subject: resource.subject });
    unsubscribe();
    store.setServerConnected(false);
  });

  it.each([
    [false, false],
    [false, undefined],
    [true, false],
    [true, undefined],
  ])(
    'rejects non-durable saves (local-only: %s, capability: %s)',
    async (localOnly, capability) => {
      const { store, resource } = await document(localOnly);
      store.setServerConnected(false);
      const write = mockLocalPersistence(store);
      Object.assign(store.getClientDb()!, {
        supportsDurablePersistence: capability,
      });

      await expect(resource.save()).rejects.toThrow(
        'could not be saved on this device',
      );
      expect(write).not.toHaveBeenCalled();
    },
  );

  it('returns only local evidence for an offline save', async () => {
    const { store, resource } = await document();
    store.setServerConnected(false);
    const write = durableWrites(store);
    const receipt = await resource.saveWithReceipt();
    expect(receipt).toEqual({
      status: 'offline',
      subject: resource.subject,
      local: { version: snapshotVersion(write.mock.calls.at(-1)![2]!) },
    });
  });

  it.each(['missing', 'failed'])(
    'rejects required local persistence when %s',
    async state => {
      const { store, resource } = await document(true);
      if (state === 'failed')
        durableWrites(store).mockRejectedValue(new Error('Disk full'));
      await expect(resource.saveWithReceipt()).rejects.toThrow();
      store.setServerConnected(false);
    },
  );

  it.each(['replacement', 'roundtrip', 'database'])(
    'rejects local evidence after %s during the flush',
    async change => {
      const { store, resource } = await document(true);
      const write = durableWrites(store);
      const gate = deferred<void>();
      write.mockReturnValueOnce(gate.promise);
      const saving = resource.saveWithReceipt();
      const rejected = expect(saving).rejects.toThrow(/Identity|database/);
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      const original = store.getAgent();

      if (change === 'database') durableWrites(store);
      else {
        store.setAgent(undefined);
        if (change === 'roundtrip') store.setAgent(original);
      }

      gate.resolve();
      await rejected;
      store.setServerConnected(false);
    },
  );

  it('rejects an identity roundtrip during asynchronous local signing', async () => {
    const { store, resource } = await document(true);
    await resource.set(core.properties.name, 'Needs signing', false);
    const write = durableWrites(store);
    const sign = resource.signChanges.bind(resource);
    const gate = deferred<void>();
    const signer = vi
      .spyOn(resource, 'signChanges')
      .mockImplementation(async agent => {
        await gate.promise;

        return sign(agent);
      });
    const saving = resource.saveWithReceipt();
    const rejected = expect(saving).rejects.toThrow('Identity changed');
    await vi.waitFor(() => expect(signer).toHaveBeenCalledTimes(1));
    const original = store.getAgent();
    store.setAgent(undefined);
    store.setAgent(original);
    gate.resolve();
    await rejected;
    expect(write).not.toHaveBeenCalled();
    store.setServerConnected(false);
  });

  it('rejects an identity roundtrip during server acceptance', async () => {
    const { store, resource, postCommitSpy } = await document();
    const gate = deferred<Commit>();
    postCommitSpy.mockReturnValueOnce(gate.promise);
    const saving = resource.saveWithReceipt();
    const rejected = expect(saving).rejects.toThrow('Identity changed');
    await vi.waitFor(() => expect(postCommitSpy).toHaveBeenCalledTimes(1));
    const original = store.getAgent();
    store.setAgent(undefined);
    store.setAgent(original);
    gate.resolve(postCommitSpy.mock.calls[0][0]);
    await rejected;
    store.setServerConnected(false);
  });

  it('omits server evidence for a custom transport even if it detaches before completion', async () => {
    const { store, resource, postCommitSpy } = await document();
    store.setCommitTransport(async commit => {
      store.setCommitTransport(undefined);

      return commit;
    });
    const receipt = await resource.saveWithReceipt();
    expect(receipt.server).toBeUndefined();
    expect(receipt.status).toBe('persisted');
    expect(postCommitSpy).not.toHaveBeenCalled();
    store.setServerConnected(false);
  });

  it('keeps server evidence when a custom transport attaches after dispatch', async () => {
    const { store, resource, postCommitSpy } = await document();
    postCommitSpy.mockImplementationOnce(async (commit: Commit) => {
      store.setCommitTransport(async other => other);

      return commit;
    });
    expect((await resource.saveWithReceipt()).server).toBeDefined();
    store.setCommitTransport(undefined);
    store.setServerConnected(false);
  });

  it.each(['genesis', 'update'])(
    'never resends accepted %s when receipt bookkeeping throws',
    async kind => {
      const { store, resource, postCommitSpy } = await document();

      if (kind === 'update') {
        await resource.save();
        await resource.set(core.properties.name, 'Update', false);
        postCommitSpy.mockClear();
      }

      vi.spyOn(resource, 'recordServerAcceptance').mockImplementation(() => {
        throw new Error('Receipt encoding failed');
      });
      const receipt = await resource.saveWithReceipt();
      expect(receipt.server).toBeUndefined();
      expect(receipt.status).toBe('persisted');
      expect(store.outbox.hasPending(resource.subject)).toBe(false);
      expect(resource.hasUnsavedChanges()).toBe(false);
      expect((await resource.saveWithReceipt()).status).toBe('noop');
      expect(postCommitSpy).toHaveBeenCalledTimes(1);
      store.setServerConnected(false);
    },
  );

  it('keeps the accepted update version separate from newer local edits', async () => {
    const { store, resource, postCommitSpy } = await document();
    await resource.save();
    await resource.set(core.properties.name, 'Accepted', false);
    const gate = deferred<Commit>();
    postCommitSpy.mockReturnValueOnce(gate.promise);
    const saving = resource.saveWithReceipt();
    await vi.waitFor(() => expect(postCommitSpy).toHaveBeenCalledTimes(2));
    const sent = postCommitSpy.mock.calls[1][0] as Commit;
    const acceptedVersion = encodeB64(
      LoroLoader.Loro.decodeImportBlobMeta(
        sent.loroUpdate!,
        false,
      ).partialEndVersionVector.encode(),
    );
    await resource.set(core.properties.name, 'Later', false);
    gate.resolve(sent);
    const receipt = await saving;
    expect(receipt.server?.version).toBe(acceptedVersion);
    expect(resource.hasOpsPastSaveCursor()).toBe(true);
    store.setServerConnected(false);
  });

  it('does not add a local receipt after an optional mirror times out', async () => {
    const { store, resource } = await document();
    const write = durableWrites(store);
    const gate = deferred<void>();
    write.mockReturnValue(gate.promise);
    const receipt = await resource.saveWithReceipt();
    expect(receipt.server).toBeDefined();
    expect(receipt.local).toBeUndefined();
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(receipt.local).toBeUndefined();
    expect(Object.isFrozen(receipt)).toBe(true);
    store.setServerConnected(false);
  }, 10_000);

  it('keeps server evidence when the optional local write rejects', async () => {
    const { store, resource } = await document();
    durableWrites(store).mockRejectedValue(new Error('Disk full'));
    const receipt = await resource.saveWithReceipt();
    expect(receipt.status).toBe('persisted');
    expect(receipt.server).toBeDefined();
    expect(receipt.local).toBeUndefined();
    expect(resource.commitError).toBeUndefined();
    store.setServerConnected(false);
  });

  it.each(['save', 'saveWithReceipt'] as const)(
    '%s preserves background pacing and explicit bypass',
    async method => {
      const { store, resource, postCommitSpy } = await document();
      await resource[method]();
      store.reportServerPace(30_000);
      await resource.set(core.properties.name, 'Next', false);
      const count = postCommitSpy.mock.calls.length;
      await expect(
        resource[method]({ background: true }),
      ).rejects.toBeInstanceOf(SaveQueuedError);
      expect(postCommitSpy).toHaveBeenCalledTimes(count);
      await resource[method]();
      expect(postCommitSpy).toHaveBeenCalledTimes(count + 1);
      store.setServerConnected(false);
    },
  );
});
