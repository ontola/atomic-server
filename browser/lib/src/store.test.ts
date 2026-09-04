import { describe, it, vi, afterEach } from 'vitest';
import { Resource, Store, core, Core, Datatype } from './index.js';
import { bootstrapCoreVocab } from './test-vocab.js';
import { testStore } from './test-store.js';

describe('Store', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the populate value', async ({ expect }) => {
    const store = new Store();
    const subject = 'https://atomicdata.dev/test';
    const testval = 'Hi world';
    const newResource = new Resource(subject);
    await newResource.set(core.properties.description, testval, false);
    store.addResource(newResource);
    const gotResource = store.getResourceLoading(subject);
    const atomString = gotResource!
      .get(core.properties.description)!
      .toString();
    expect(atomString).to.equal(testval);
  });

  it('fetches a resource', async ({ expect }) => {
    const store = new Store({ serverUrl: 'https://atomicdata.dev' });
    // Hermetic: serve the resource from a mock instead of the live domain, so
    // the test exercises the fetch+parse path without depending on the network.
    store.injectFetch(
      async () =>
        new Response(
          JSON.stringify({
            '@id': 'https://atomicdata.dev/properties/createdAt',
            'https://atomicdata.dev/properties/shortname': 'created-at',
            'https://atomicdata.dev/properties/description':
              'When the resource was created.',
            'https://atomicdata.dev/properties/datatype':
              'https://atomicdata.dev/datatypes/timestamp',
            'https://atomicdata.dev/properties/isA': [
              'https://atomicdata.dev/classes/Property',
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/ad+json' } },
        ),
    );
    const resource = await store.getResource(
      'https://atomicdata.dev/properties/createdAt',
    );

    if (resource.error) {
      throw resource.error;
    }

    const atomString = resource.get(core.properties.shortname)!.toString();
    expect(atomString).toBe('created-at');
  });

  it('accepts a custom fetch implementation', async ({ expect }) => {
    const testResourceSubject = 'https://atomicdata.dev';

    const customFetch = vi.fn(
      async (url: RequestInfo | URL, options: RequestInit | undefined) => {
        return fetch(url, options);
      },
    );

    const store = new Store();

    await store.fetchResourceFromServer(testResourceSubject, {
      noWebSocket: true,
    });

    expect(customFetch.mock.calls).toHaveLength(0);

    store.injectFetch(customFetch);

    await store.fetchResourceFromServer(testResourceSubject, {
      noWebSocket: true,
    });

    expect(customFetch.mock.calls).toHaveLength(1);
  });

  it('creates new resources using store.newResource()', async ({ expect }) => {
    const store = new Store({ serverUrl: 'https://myserver.dev' });
    // Seed core vocab so property validation resolves from cache instead of
    // fetching atomicdata.dev (keeps the test hermetic + fast).
    await bootstrapCoreVocab(store);

    const resource1 = await store.newResource<Core.Property>({
      subject: 'https://myserver.dev/testthing',
      parent: 'https://myserver.dev/properties',
      isA: core.classes.property,
      propVals: {
        [core.properties.datatype]: Datatype.SLUG,
        [core.properties.shortname]: 'testthing',
      },
    });

    expect(resource1.props.parent).toBe('https://myserver.dev/properties');
    expect(resource1.props.datatype).toBe(Datatype.SLUG);
    expect(resource1.props.shortname).toBe('testthing');
    expect(resource1.hasClasses(core.classes.property)).toBe(true);

    const resource2 = await store.newResource({ did: false });

    expect(resource2.props.parent).toBe('https://myserver.dev/');
    expect(resource2.get(core.properties.isA)).toBe(undefined);
  });

  it('normalizes the default root parent when creating resources', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://myserver.dev' });

    const resource = await store.newResource({ did: false });

    expect(resource.props.parent).toBe('https://myserver.dev/');
  });

  it('resolves aliases correctly', async ({ expect }) => {
    const store = new Store();
    const alias = 'https://atomicdata.dev/alias';
    const did = 'did:ad:123';

    const resource = new Resource(did);
    await resource.set(core.properties.description, 'Identity verified', false);

    // Explicitly add with alias
    store.addResource(resource, { alias });

    // Both subjects should return the same resource
    const gotByAlias = store.getResourceLoading(alias);
    const gotByDID = store.getResourceLoading(did);

    expect(gotByAlias.subject).toBe(did);
    expect(gotByDID.subject).toBe(did);
    expect(gotByAlias).toBe(gotByDID);
  });

  it('normalizes relative subjects to full URLs', async ({ expect }) => {
    const store = new Store({ serverUrl: 'https://myserver.dev' });

    // Relative path should become full URL
    const normalizedRelative = store.normalizeSubject('classes');
    expect(normalizedRelative).toBe('https://myserver.dev/classes');

    // Full URL should remain unchanged
    const normalizedFull = store.normalizeSubject(
      'https://myserver.dev/classes?page_size=10',
    );
    expect(normalizedFull).toBe('https://myserver.dev/classes?page_size=10');

    // DID should remain unchanged
    const normalizedDID = store.normalizeSubject('did:ad:123');
    expect(normalizedDID).toBe('did:ad:123');
  });

  it('rehydrates local search from the ClientDb so offline search survives a reload', async ({
    expect,
  }) => {
    // `LocalSearch` is in-memory and starts empty on every page load.
    // `setClientDb` must rebuild it from the persistent ClientDb so a
    // reloaded, offline session can still search its whole local dataset.
    const store = new Store({ serverUrl: 'https://atomicdata.dev' });
    const driveSubject = 'https://atomicdata.dev/test-drive';
    const subject = 'https://atomicdata.dev/offline-search-target';
    const name = 'ZephyrQuokkaOfflineTarget';
    const exported = JSON.stringify([
      {
        '@id': subject,
        [core.properties.name]: name,
        [core.properties.parent]: driveSubject,
      },
    ]);

    const fakeClientDb = {
      isReady: true,
      isInitialized: true,
      initError: undefined,
      waitForReady: async () => true,
      exportAllResources: async () => exported,
    };

    store.setClientDb(
      fakeClientDb as unknown as Parameters<Store['setClientDb']>[0],
    );

    // Rehydration runs in the background — poll until the resource is
    // searchable from the local index (no server is reachable here).
    let results: string[] = [];

    for (let i = 0; i < 100 && results.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      results = await store.search(name, { parents: driveSubject });
    }

    expect(results).toContain(subject);
  });

  it('only rehydrates local search once when ensureDriveIndexed is called', async ({
    expect,
  }) => {
    // We now index lazily on first search, not eagerly on setClientDb.
    // ensureDriveIndexed deduplicates concurrent or sequential builds.
    const store = new Store({ serverUrl: 'https://atomicdata.dev' });
    let exportCallCount = 0;
    const fakeClientDb = {
      isReady: true,
      isInitialized: true,
      initError: undefined,
      waitForReady: async () => true,
      exportAllResources: async () => {
        exportCallCount++;

        return JSON.stringify([]);
      },
    };

    store.setClientDb(
      fakeClientDb as unknown as Parameters<Store['setClientDb']>[0],
    );
    store.setClientDb(
      fakeClientDb as unknown as Parameters<Store['setClientDb']>[0],
    );

    // Verify eager rehydration did not occur
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(exportCallCount).toBe(0);

    // Trigger drive indexing concurrently
    const drive = 'https://atomicdata.dev/test-drive';
    await Promise.all([
      store.ensureDriveIndexed(drive),
      store.ensureDriveIndexed(drive),
      store.ensureDriveIndexed(drive),
    ]);

    expect(exportCallCount).toBe(1);
  });

  it('excludes subjects with a pending outbox entry from the VV sync state (F1 interim)', async ({
    expect,
  }) => {
    // planning/unified-sync.md F1: a subject mid-backoff (or just not yet
    // drained this pass) must not appear in the VV state sent to the
    // server — otherwise the server sees the client "ahead" and requests
    // a SYNC_PUSH of the raw, unsigned Loro bytes for it, bypassing the
    // outbox's signed-commit path (and the hub's rights check) entirely.
    const { store } = await testStore();
    const driveSubject = 'https://example.com/drive';

    const clean = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: { [core.properties.name]: 'Clean' },
      parent: driveSubject,
    });
    await clean.save();

    const dirty = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: { [core.properties.name]: 'Dirty' },
      parent: driveSubject,
    });
    await dirty.save();

    // Simulate a pending outbox entry that hasn't drained yet — e.g. mid
    // backoff after a prior failed attempt.
    store.outbox.markDirty(dirty.subject);

    const syncState = await store.computeDriveSyncState(driveSubject);

    expect(syncState.resources[clean.subject]).toBeDefined();
    expect(syncState.resources[dirty.subject]).toBeUndefined();
  });

  it('cold-drains outbox entries for subjects no longer in memory', async ({
    expect,
  }) => {
    // Reload-stranded entry (planning/completed/outbox-drain-data-loss-race.md, root
    // cause 3): an outbox entry restored from localStorage after a page load,
    // for a subject nothing on the current page renders. The drain must load
    // the resource itself and POST the pending delta — returning silently
    // would leave `pendingDirtyCount` stuck > 0 forever and never deliver
    // the write.
    const { store, posted } = await testStore();

    const resource = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: { [core.properties.name]: 'Before' },
      parent: 'https://example.com/drive',
    });
    await resource.save();
    const subject = resource.subject;
    const postedBefore = posted.length;

    // Edit, then simulate the reload: the dirty bit is in the outbox (as if
    // hydrated from localStorage) but the resource is gone from memory.
    await resource.set(core.properties.name, 'After', false);
    store.outbox.markDirty(subject);
    store.resources.delete(subject);

    // The cold drain "loads" it — stub the fetch to hand the hydrated
    // resource back, like the OPFS/server path would.
    const getResourceSpy = vi
      .spyOn(store, 'getResource')
      .mockImplementation(async (s: string) => {
        expect(s).toBe(subject);
        store.resources.set(subject, resource);

        return resource;
      });

    await store.syncDirtyResources();

    expect(getResourceSpy).toHaveBeenCalled();
    expect(posted.length).toBe(postedBefore + 1);
    expect(store.outbox.hasPending(subject)).toBe(false);
    expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
  });

  it('counts scheduled (debounce-pending) saves in sync status', ({
    expect,
  }) => {
    // UI layers (useValue's commitDebounce) park a save() in a timer; until
    // it fires the edit is only in memory. Sync status must not report
    // "fully synced" during that window (planning/completed/outbox-drain-data-loss-race.md).
    const store = new Store({ serverUrl: 'https://example.com' });

    expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
    expect(store.getSyncStatus().syncInProgress).toBe(false);

    store.startScheduledSave();
    store.startScheduledSave();
    expect(store.getSyncStatus().pendingDirtyCount).toBe(2);
    expect(store.getSyncStatus().syncInProgress).toBe(true);

    store.finishScheduledSave();
    expect(store.getSyncStatus().pendingDirtyCount).toBe(1);

    store.finishScheduledSave();
    expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
    expect(store.getSyncStatus().syncInProgress).toBe(false);

    // Unbalanced finish must not go negative and mask real dirty state.
    store.finishScheduledSave();
    expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
  });
});
