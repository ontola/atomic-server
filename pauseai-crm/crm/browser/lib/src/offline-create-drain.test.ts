import { describe, it } from 'vitest';
import { server } from './ontologies/server.js';
import { testStore } from './test-store.js';

/**
 * Reproduces the develop full-e2e failure of
 * `offline-create-then-online`: an extra drive created while disconnected
 * left its default ontology (genesis-only) with a rewind `baseVersion`
 * equal to the genesis cursor. Reconnect POSTed genesis, then treated the
 * empty follow-up export as "OPFS not ready" and retried forever —
 * `pendingDirtyCount` stuck at 1, `hasSignedGenesis` false.
 */
describe('offline create drain', () => {
  it('does not capture a rewind baseline on an unposted genesis', async ({
    expect,
  }) => {
    const { store } = await testStore();
    await store.createDrive('Home', { personal: true });
    store.setServerConnected(false);

    const extra = await store.createDrive('Offline-Created Drive', {
      personal: false,
    });
    expect(extra.subject.startsWith('did:ad:')).toBe(true);

    const pending = store.outbox.pending();
    expect(pending.length).toBeGreaterThan(0);

    for (const entry of pending) {
      if (entry.signedGenesis) {
        expect(entry.baseVersion).toBeUndefined();
      }
    }
  });

  it('reconnect drain clears a genesis-only extra drive and its ontology', async ({
    expect,
  }) => {
    const { store } = await testStore();
    await store.createDrive('Home', { personal: true });
    store.setServerConnected(false);

    const extra = await store.createDrive('Offline-Created Drive', {
      personal: false,
    });
    const ontology = extra.get(server.properties.defaultOntology) as string;
    expect(ontology).toBeTruthy();

    store.setServerConnected(true);
    await store.syncDirtyResources();

    expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
    expect(store.outbox.getEntry(extra.subject)).toBeUndefined();
    expect(store.outbox.getEntry(ontology)).toBeUndefined();
  });

  it('drain does not strand a genesis that wrongly had a baseline', async ({
    expect,
  }) => {
    const { store } = await testStore();
    await store.createDrive('Home', { personal: true });
    store.setServerConnected(false);

    const extra = await store.createDrive('Offline-Created Drive', {
      personal: false,
    });
    const ontology = extra.get(server.properties.defaultOntology) as string;
    const ontoEntry = store.outbox.getEntry(ontology);
    expect(ontoEntry?.signedGenesis).toBeTruthy();

    const ontoResource = store.resources.get(ontology);
    const cursor = ontoResource?.getEncodedSaveCursor();
    expect(cursor).toBeTruthy();

    // The pre-fix saveOffline shape: genesis cursor stored as rewind
    // baseline. Drain must still clear after POSTing genesis.
    store.outbox.setBaseVersion(ontology, cursor!);

    store.setServerConnected(true);
    await store.syncDirtyResources();

    expect(store.outbox.getEntry(ontology)).toBeUndefined();
    expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
  });
});
