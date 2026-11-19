import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  JSCryptoProvider,
  LoroLoader,
  Resource,
  Store,
  core,
  type ClientDbWorker,
  type VaultSyncScope,
  type ResourceReceipts,
  type SerializedReceipt,
} from '@tomic/lib';
import {
  bindResourceVaultScope,
  captureResourceVaultBackup,
  captureResourceVaultOperation,
  clearResourceVaultScopes,
  invalidateResourceVaultProof,
  subscribeResourceCopiesWithVault,
  type VaultReceiptDb,
} from './vaultResourceSync';
import { getManagedAccount, noteManagedSessionChanged } from './session';

vi.mock('loro-crdt/web', () => import('loro-crdt/nodejs'));

vi.mock('./api', () => ({
  getManagedApiBase: () => 'https://control.test/api',
}));
vi.mock('./session', () => {
  const changed = new Set<() => void>();

  return {
    getManagedAccount: vi.fn(async () => ({ email: 'acct_a' })),
    onManagedLogout: (cb: () => void) => {
      changed.add(cb);

      return () => changed.delete(cb);
    },
    onManagedSessionChanged: (cb: () => void) => {
      changed.add(cb);

      return () => changed.delete(cb);
    },
    noteManagedSessionChanged: () => {
      for (const cb of changed) cb();
    },
  };
});

beforeEach(async () => {
  await LoroLoader.initializeLoro();
  vi.mocked(getManagedAccount).mockResolvedValue({ email: 'acct_a' });
});
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });

  return { promise, resolve };
}

async function fixture(existingDb?: ReturnType<typeof database>) {
  const store = new Store({ serverUrl: 'https://node.test', connect: false });
  const keys = await Agent.generateKeyPair();
  store.setAgent(
    new Agent(
      new JSCryptoProvider(keys.privateKey),
      `atomic:agent:${keys.publicKey}`,
    ),
  );
  const db = existingDb ?? database();
  store.setClientDb(db as unknown as ClientDbWorker);
  const doc = new LoroLoader.Loro.LoroDoc();
  doc.getMap('properties').set(core.properties.name, 'Document');
  doc.commit();
  const resource = new Resource('atomic:drive');
  resource.importLoroUpdate(doc.export({ mode: 'snapshot' }), true);
  resource.setStore(store);
  resource.loading = false;
  resource.new = false;
  store.resources.set(resource.subject, resource);
  const scope: VaultSyncScope = {
    managedAccount: 'acct_a',
    agent: store.getAgent()!.subject!,
    portalUrl: 'https://control.test/api',
    drive: resource.subject,
    drivePseudonym: 'vault-a',
    keyEpoch: 1,
  };

  return { store, resource, db, scope };
}

function database() {
  let generation = 0;
  const receipts = new Map<string, SerializedReceipt>();
  const db = {
    isReady: true,
    getResourceVaultGeneration: vi.fn(async () => generation),
    getResourceReceipts: vi.fn(async (): Promise<ResourceReceipts[]> => []),
    putResourceReceipts: vi.fn(
      async (
        _scope: { vault: VaultSyncScope },
        rows: SerializedReceipt[],
        expected: number,
      ) => {
        if (expected !== generation) return false;
        for (const row of rows) receipts.set(row.subject, row);

        return true;
      },
    ),
    clearResourceVaultReceipts: vi.fn(async (_scope: VaultSyncScope) => {
      generation++;
      receipts.clear();
    }),
    receipts,
  };

  return db;
}

function proof(resource: Resource) {
  resource.sealPendingEdits();

  return {
    objectKey: 'vault-object',
    confirmedAt: 123,
    resourceVersions: {
      [resource.subject]: Object.fromEntries(
        resource.getLoroDoc()!.oplogVersion().toJSON(),
      ),
    },
  };
}

function stored(resource: Resource): ResourceReceipts {
  return {
    subject: resource.subject,
    snapshot: resource.getLoroDoc()!.export({ mode: 'snapshot' }),
    receipts: [
      {
        subject: resource.subject,
        version: proof(resource).resourceVersions[resource.subject],
        confirmedAt: 123,
      },
    ],
  };
}

function edit(resource: Resource) {
  resource
    .getLoroDoc()!
    .getMap('properties')
    .set(core.properties.name, 'New edit');
  resource.sealPendingEdits();
}

describe('resource Vault proof', () => {
  it('keeps getters pure and confirms only the exported version after accepted durable proof', async () => {
    const { store, db, resource, scope } = await fixture();
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    expect(db.getResourceReceipts).not.toHaveBeenCalled();
    const capture = captureResourceVaultBackup(store, db, scope);
    expect(await capture.isCurrent()).toBe(true);
    const exported = proof(resource);
    edit(resource);
    await capture.confirm(exported);
    expect(store.getResourceCopies(resource).vault.state).toBe('pending');
    expect(store.getResourceCopies(resource).vault.confirmedAt).toBe(123);
    await capture.confirm(proof(resource));
    expect(store.getResourceCopies(resource).vault.state).toBe('confirmed');
  });

  it('hydrates valid persisted proof only after the known scope is bound', async () => {
    const { store, db, resource, scope } = await fixture();
    db.getResourceReceipts.mockResolvedValue([stored(resource)]);
    const stop = subscribeResourceCopiesWithVault(store, resource, vi.fn());
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    expect(db.getResourceReceipts).not.toHaveBeenCalled();
    bindResourceVaultScope(store, db, scope);
    await vi.waitFor(() =>
      expect(store.getResourceCopies(resource).vault.state).toBe('confirmed'),
    );
    expect(store.getResourceCopies(resource).vault.confirmedAt).toBe(123);
    clearResourceVaultScopes(store);
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    stop();
  });

  it('does not adopt another agent scope when an old capture is rejected', async () => {
    const { store, db, resource, scope } = await fixture();
    const other = await fixture();
    store.setAgent(other.store.getAgent());
    const fresh = { ...scope, agent: store.getAgent()!.subject! };
    bindResourceVaultScope(store, db, fresh);
    const old = captureResourceVaultBackup(store, db, scope);
    expect(await old.isCurrent()).toBe(false);
    await old.confirm(proof(resource));
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    expect(db.putResourceReceipts).not.toHaveBeenCalled();
  });

  it('fences setup and live callbacks on managed session change even for the same account', async () => {
    const { store, db, resource, scope } = await fixture();
    const setupCurrent = captureResourceVaultOperation(store);
    const old = captureResourceVaultBackup(store, db, scope);
    await old.isCurrent();
    noteManagedSessionChanged();
    expect(setupCurrent()).toBe(false);
    bindResourceVaultScope(store, db, scope);
    await old.confirm(proof(resource));
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    expect(db.putResourceReceipts).not.toHaveBeenCalled();
  });

  it('refuses a previous account and preserves unsupported adapters as unknown', async () => {
    const { store, db, resource, scope } = await fixture();
    const old = captureResourceVaultBackup(store, db, scope);
    vi.mocked(getManagedAccount).mockResolvedValue({ email: 'acct_b' });
    expect(await old.isCurrent()).toBe(false);
    await old.confirm(proof(resource));
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    const unsupported = captureResourceVaultBackup(
      store,
      {} as VaultReceiptDb,
      scope,
    );
    await unsupported.confirm(proof(resource));
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
  });

  it('does not infer the resource workspace from the currently open drive', async () => {
    const { store, db, resource, scope } = await fixture();
    bindResourceVaultScope(store, db, scope);
    store.setDrive(resource.subject);
    const unrelated = new Resource('atomic:unrelated');
    unrelated.importLoroUpdate(
      resource.getLoroDoc()!.export({ mode: 'snapshot' }),
      true,
    );
    unrelated.setStore(store);
    const stop = subscribeResourceCopiesWithVault(store, unrelated, vi.fn());
    await Promise.resolve();
    expect(store.getResourceCopies(unrelated).vault.state).toBe('unknown');
    expect(db.getResourceReceipts).not.toHaveBeenCalled();
    stop();
  });

  it('ignores a stale read after eviction and resubscription and rejects corrupted snapshots', async () => {
    const { store, db, resource, scope } = await fixture();
    const read = deferred<ResourceReceipts[]>();
    // Each watch reads the contents proof first, then the document proof.
    db.getResourceReceipts
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue([]);
    bindResourceVaultScope(store, db, scope);
    const stop = subscribeResourceCopiesWithVault(store, resource, vi.fn());
    await vi.waitFor(() => expect(db.getResourceReceipts).toHaveBeenCalled());
    store.evictResource(resource.subject);
    stop();
    store.resources.set(resource.subject, resource);
    const stopAgain = subscribeResourceCopiesWithVault(
      store,
      resource,
      vi.fn(),
    );
    read.resolve([stored(resource)]);
    await vi.waitFor(() =>
      expect(db.getResourceReceipts).toHaveBeenCalledTimes(4),
    );
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    stopAgain();
    clearResourceVaultScopes(store);
    db.getResourceReceipts.mockResolvedValue([
      { ...stored(resource), snapshot: new Uint8Array([1, 2, 3]) },
    ]);
    bindResourceVaultScope(store, db, scope);
    const stopCorrupt = subscribeResourceCopiesWithVault(
      store,
      resource,
      vi.fn(),
    );
    await vi.waitFor(() =>
      expect(db.getResourceReceipts).toHaveBeenCalledTimes(6),
    );
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    stopCorrupt();
  });

  it('rejects an old-generation write after another tab clears and accepts a newly captured generation', async () => {
    const { store, db, resource, scope } = await fixture();
    const old = captureResourceVaultBackup(store, db, scope);
    expect(await old.isCurrent()).toBe(true);
    const write = deferred<void>();
    const actualWrite = db.putResourceReceipts.getMockImplementation()!;
    db.putResourceReceipts.mockImplementationOnce(async (...args) => {
      await write.promise;

      return actualWrite(...args);
    });
    const pending = old.confirm(proof(resource));
    await vi.waitFor(() => expect(db.putResourceReceipts).toHaveBeenCalled());
    await db.clearResourceVaultReceipts(scope);
    write.resolve();
    await pending;
    expect(db.receipts.size).toBe(0);
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    const fresh = captureResourceVaultBackup(store, db, scope);
    await fresh.confirm(proof(resource));
    expect(store.getResourceCopies(resource).vault.state).toBe('confirmed');
  });

  it('withholds proof on diagnostic generation/storage failure without rejecting the backup callback', async () => {
    const { store, db, resource, scope } = await fixture();
    const capture = captureResourceVaultBackup(store, db, scope);
    await Promise.resolve();
    db.getResourceVaultGeneration.mockRejectedValueOnce(
      new Error('Storage unavailable'),
    );
    expect(await capture.isCurrent()).toBe(true);
    await expect(capture.confirm(proof(resource))).resolves.toBeUndefined();
    expect(db.putResourceReceipts).not.toHaveBeenCalled();
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
    const next = captureResourceVaultBackup(store, db, scope);
    db.putResourceReceipts.mockRejectedValueOnce(new Error('Flush failed'));
    await expect(next.confirm(proof(resource))).resolves.toBeUndefined();
    expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
  });

  it('clears durable proof before a bound context exists and prevents old callbacks reviving it', async () => {
    const { store, db, resource, scope } = await fixture();
    db.receipts.set(resource.subject, stored(resource).receipts[0]);
    await invalidateResourceVaultProof(store, scope.drivePseudonym, {
      scope,
      db,
    });
    expect(db.clearResourceVaultReceipts).toHaveBeenCalledWith(scope);
    expect(db.receipts.size).toBe(0);
    const old = captureResourceVaultBackup(store, db, scope);
    await old.isCurrent();
    await invalidateResourceVaultProof(store, scope.drivePseudonym, {
      scope,
      db,
    });
    bindResourceVaultScope(store, db, scope);
    await old.confirm(proof(resource));
    expect(store.getResourceCopies(resource).vault.state).toBe('unknown');
  });
});

describe('Vault file content confirmations', () => {
  const hash = 'a'.repeat(64);

  async function attachmentFixture() {
    const f = await fixture();
    await f.resource.set(
      'https://atomicdata.dev/properties/isA',
      ['https://atomicdata.dev/classes/File'],
      false,
    );
    await f.resource.set(
      'https://atomicdata.dev/properties/blob',
      `atomic:blob:${hash}`,
      false,
    );
    await f.resource.set(
      'https://atomicdata.dev/properties/internalId',
      hash,
      false,
    );
    const manifest = {
      files: [{ subject: f.resource.subject, hash, chunks: [] }],
    };

    return { ...f, manifest };
  }

  it('binds hash proof before upload, permits rename, and withholds coverage after replacement', async () => {
    const f = await attachmentFixture();
    const capture = captureResourceVaultBackup(f.store, f.db, f.scope);
    expect(await capture.isCurrent()).toBe(true);
    await capture.confirmAttachments([hash]);
    expect(f.store.getResourceCopies(f.resource).vault.contents.state).toBe(
      'confirmed',
    );
    await f.resource.set(core.properties.name, 'Renamed', false);
    expect(f.store.getResourceCopies(f.resource).vault.contents.state).toBe(
      'confirmed',
    );
    await f.resource.set(
      'https://atomicdata.dev/properties/blob',
      `atomic:blob:${'b'.repeat(64)}`,
      false,
    );
    await f.resource.set(
      'https://atomicdata.dev/properties/internalId',
      'b'.repeat(64),
      false,
    );
    expect(f.store.getResourceCopies(f.resource).vault.contents.state).toBe(
      'pending',
    );
    expect(f.db.putResourceReceipts.mock.calls[0]![1][0].manifest).toEqual(
      f.manifest,
    );
  });
  it('does not mint live proof after rejected durable generation or account change', async () => {
    const f = await attachmentFixture();
    const capture = captureResourceVaultBackup(f.store, f.db, f.scope);
    f.db.putResourceReceipts.mockResolvedValue(false);
    await capture.confirmAttachments([hash]);
    expect(f.store.getResourceCopies(f.resource).vault.contents.state).toBe(
      'unknown',
    );
    const next = captureResourceVaultBackup(f.store, f.db, f.scope);
    noteManagedSessionChanged();
    f.db.putResourceReceipts.mockClear();
    await next.confirmAttachments([hash]);
    expect(f.db.putResourceReceipts).not.toHaveBeenCalled();
  });
  it('hydrates accepted manifests under the established account scope with original time', async () => {
    const f = await attachmentFixture();
    f.db.getResourceReceipts.mockResolvedValue([
      {
        subject: f.resource.subject,
        snapshot: null,
        receipts: [
          {
            subject: f.resource.subject,
            version: {},
            manifest: f.manifest,
            confirmedAt: 123,
          },
        ],
      },
    ]);
    bindResourceVaultScope(f.store, f.db, f.scope);
    const stop = subscribeResourceCopiesWithVault(
      f.store,
      f.resource,
      () => {},
    );
    await vi.waitFor(() =>
      expect(
        f.store.getResourceCopies(f.resource).vault.contents,
      ).toMatchObject({ state: 'confirmed', confirmedAt: 123 }),
    );
    stop();
  });
  it('captures unloaded persisted attachment manifests before export', async () => {
    const f = await attachmentFixture();
    const db = Object.assign(f.db, {
      vaultAttachmentManifests: vi.fn(async () => [
        {
          subject: 'atomic:unloaded',
          manifest: {
            files: [{ subject: 'atomic:unloaded', hash, chunks: [] }],
          },
        },
      ]),
    });
    const capture = captureResourceVaultBackup(f.store, db, f.scope);
    expect(await capture.isCurrent()).toBe(true);
    await capture.confirmAttachments([hash]);
    expect(db.putResourceReceipts).toHaveBeenCalledWith(
      { vault: f.scope },
      [expect.objectContaining({ subject: 'atomic:unloaded' })],
      0,
    );
  });
});
