import { afterEach, describe, expect, it, vi } from 'vitest';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { LoroLoader } from './loro-loader.js';
import { mockLocalPersistence, testStore } from './test-store.js';
afterEach(() => vi.restoreAllMocks());

describe('required local save persistence', () => {
  it.each(['missing', 'unsupported', 'failed'])(
    'rejects an offline save with %s storage and can retry',
    async state => {
      const { store, postCommitSpy } = await testStore();
      store.setServerConnected(false);
      const doc = await store.newResource({
        isA: server.classes.drive,
        noParent: true,
        propVals: { [core.properties.name]: 'Keep this edit' },
      });

      if (state !== 'missing') {
        const write = mockLocalPersistence(store, state === 'unsupported');
        if (state === 'failed') write.mockRejectedValue(new Error('Disk full'));
      }

      const saved = vi.spyOn(store, 'notifyResourceSaved');
      await expect(doc.save()).rejects.toThrow();
      expect(doc.get(core.properties.name)).toBe('Keep this edit');
      expect(store.outbox.hasPending(doc.subject)).toBe(true);
      expect(doc.commitError).toBeInstanceOf(Error);
      expect(store.getSaveState(doc).kind).toBe('error');
      expect(saved).not.toHaveBeenCalled();

      const write = mockLocalPersistence(store);
      await expect(doc.save()).resolves.toBe('offline');
      expect(write).toHaveBeenCalled();
      expect(doc.commitError).toBeUndefined();
      expect(store.getSaveState(doc).kind).toBe('queued');
      expect(saved).toHaveBeenCalledTimes(1);
      expect(postCommitSpy).not.toHaveBeenCalled();
    },
  );

  it('reports failed local persistence after a network failure', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
    });
    postCommitSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(doc.save()).rejects.toThrow('Keep this window open');
    expect(store.serverConnected).toBe(false);
    expect(doc.commitError?.message).toContain('Keep this window open');
    expect(store.getSaveState(doc)).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('Keep this window open'),
    });
    expect(store.outbox.hasPending(doc.subject)).toBe(true);

    mockLocalPersistence(store);
    await expect(doc.save()).resolves.toBe('offline');
    expect(doc.commitError).toBeUndefined();
  });

  it.each(['missing', 'unsupported', 'failed'])(
    'retains signed local-only genesis and edits when storage is %s',
    async state => {
      const { store, postCommitSpy } = await testStore();
      store.setServerConnected(false);
      const signedLog = vi.spyOn(store, 'logPendingCommit');
      const doc = await store.newResource({
        isA: server.classes.drive,
        noParent: true,
        propVals: { [core.properties.name]: 'Local-only edit' },
      });
      store.registerLocalOnlyDrive(doc.subject);
      await doc.set(core.properties.name, 'Edited after genesis', false);
      const publish = vi.spyOn(store, 'publishPeerCommit');
      const settled = vi.spyOn(store, 'logLocalOnlyCommitSettled');
      const saved = vi.spyOn(store, 'notifyResourceSaved');

      if (state !== 'missing') {
        const write = mockLocalPersistence(store, state === 'unsupported');
        if (state === 'failed') write.mockRejectedValue(new Error('Disk full'));
      }

      await expect(doc.save()).rejects.toThrow();
      const signed = signedLog.mock.calls.map(([commit]) => commit);
      expect(signed).toHaveLength(2);
      expect(signed[0].isGenesis).toBe(true);
      expect(doc.hasUnsavedChanges()).toBe(true);
      expect(store.getSaveState(doc).kind).toBe('error');
      expect(settled).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(saved).not.toHaveBeenCalled();

      const write = mockLocalPersistence(store);
      let finishWrite!: () => void;
      write.mockImplementationOnce(
        () => new Promise<void>(resolve => (finishWrite = resolve)),
      );
      const retry = doc.save();
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(settled).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(saved).not.toHaveBeenCalled();
      finishWrite();
      await expect(retry).resolves.toBe('persisted');
      expect(publish.mock.calls.map(([commit]) => commit)).toEqual(signed);
      expect(settled.mock.calls.map(([commit]) => commit)).toEqual(signed);
      expect(doc.get(core.properties.name)).toBe('Edited after genesis');
      expect(doc.commitError).toBeUndefined();
      expect(doc.hasUnsavedChanges()).toBe(false);
      expect(saved).toHaveBeenCalledTimes(1);
      expect(postCommitSpy).not.toHaveBeenCalled();
      await expect(doc.save()).resolves.toBe('noop');
    },
  );

  it('keeps the persistence boolean about outbox rows, not snapshot success', async () => {
    const { store } = await testStore();
    store.setServerConnected(false);
    const doc = await store.newResource({ noParent: true });
    const write = mockLocalPersistence(store);

    await expect(doc.persistToClientDb()).resolves.toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][2]).toBeInstanceOf(Uint8Array);
  });

  it('leaves edits made during a local-only write unsaved for the next save', async () => {
    const { store } = await testStore();
    store.setServerConnected(false);
    const doc = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'First edit' },
    });
    store.registerLocalOnlyDrive(doc.subject);
    const write = mockLocalPersistence(store);
    let finishWrite!: () => void;
    write.mockImplementationOnce(
      () => new Promise<void>(resolve => (finishWrite = resolve)),
    );
    const saving = doc.save();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await doc.set(core.properties.name, 'Newer edit', false);
    finishWrite();
    await expect(saving).resolves.toBe('persisted');

    const snapshot = new LoroLoader.Loro.LoroDoc();
    snapshot.import(write.mock.calls[0][2]!);
    expect(snapshot.getMap('properties').get(core.properties.name)).toBe(
      'First edit',
    );
    expect(doc.hasUnsavedChanges()).toBe(true);
    expect(store.getSaveState(doc).kind).toBe('dirty');
    await expect(doc.save()).resolves.toBe('persisted');
    snapshot.import(write.mock.calls[1][2]!);
    expect(snapshot.getMap('properties').get(core.properties.name)).toBe(
      'Newer edit',
    );
    expect(doc.hasUnsavedChanges()).toBe(false);
  });

  it.each(['logLocalOnlyCommitSettled', 'publishPeerCommit'] as const)(
    'retains remaining envelopes when %s throws after the write',
    async callback => {
      const { store } = await testStore();
      store.setServerConnected(false);
      const signedLog = vi.spyOn(store, 'logPendingCommit');
      const doc = await store.newResource({
        isA: server.classes.drive,
        noParent: true,
        propVals: { [core.properties.name]: 'Genesis' },
      });
      store.registerLocalOnlyDrive(doc.subject);
      await doc.set(core.properties.name, 'Next edit', false);
      const write = mockLocalPersistence(store);
      const publish = vi.spyOn(store, 'publishPeerCommit');
      const failing = vi.spyOn(store, callback).mockImplementationOnce(() => {
        throw new Error('Listener failed');
      });

      await expect(doc.save()).rejects.toThrow('Listener failed');
      expect(write).toHaveBeenCalledTimes(1);
      expect(doc.hasUnsavedChanges()).toBe(true);
      const signed = signedLog.mock.calls.map(([commit]) => commit);
      expect(signed).toHaveLength(2);
      expect(failing).toHaveBeenCalledTimes(1);
      publish.mockClear();

      await expect(doc.save()).resolves.toBe('persisted');
      expect(publish.mock.calls.map(([commit]) => commit)).toEqual(signed);
      expect(doc.hasUnsavedChanges()).toBe(false);
      await expect(doc.save()).resolves.toBe('noop');
    },
  );
});
