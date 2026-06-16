import { describe, it, vi, afterEach } from 'vitest';
import { Resource, Store, core, Core, Datatype } from './index.js';

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
});
