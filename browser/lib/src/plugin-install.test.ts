import { describe, expect, it, vi } from 'vitest';
import { AtomicError, ErrorType, PROBLEM_MARKER } from './error.js';
import { HostFeatureUnavailableError } from './plugin-manifest-http.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import {
  grantsFor,
  installRelease,
  installationIdentifier,
  publishZipRelease,
  readInstallationReview,
  updateInstallationRelease,
} from './plugin-install.js';
import { testStore } from './test-store.js';

describe('readInstallationReview', () => {
  it('reads a plugin.json style manifest with permission reasons and config', () => {
    const review = readInstallationReview({
      id: 'blake3:abc',
      runtime: 'wasip2/1',
      version: '1.0.0',
      manifest: {
        name: 'test-plugin',
        namespace: 'ontola',
        author: 'Ontola',
        description: 'Renames folders',
        permissions: [
          { permission: 'storage', reason: 'Keeps a counter' },
          'network',
          { reason: 'dropped: no permission name' },
        ],
        defaultConfig: { folderPrefix: 'My' },
        configSchema: {
          type: 'object',
          properties: { folderPrefix: { type: 'string' } },
        },
      },
    });

    expect(review).toMatchObject({
      name: 'test-plugin',
      namespace: 'ontola',
      author: 'Ontola',
      description: 'Renames folders',
      version: '1.0.0',
      runtime: 'wasip2/1',
      world: 'extension',
      releaseId: 'blake3:abc',
      defaultConfig: { folderPrefix: 'My' },
    });
    expect(review.configSchema).toMatchObject({ type: 'object' });
    expect(review.capabilities).toEqual([
      {
        kind: 'permission',
        title: 'storage',
        reason: 'Keeps a counter',
        grant: 'storage',
      },
      {
        kind: 'permission',
        title: 'network',
        reason: undefined,
        grant: 'network',
      },
    ]);
    expect(grantsFor(review)).toEqual(['storage', 'network']);
  });

  it('reads a versioned JS manifest: secrets and operations are shown but not granted', () => {
    const review = readInstallationReview({
      runtime: 'atomic-js/1',
      manifest: {
        schemaVersion: 1,
        version: '2.1.0',
        secrets: [
          {
            name: 'google',
            origin: 'https://www.googleapis.com',
            description: 'Calendar API key',
          },
          { origin: 'https://dropped.example' },
        ],
        operations: [
          {
            id: 'list-events',
            method: 'GET',
            url: 'https://www.googleapis.com/calendar/v3/events',
            effect: 'read',
          },
        ],
      },
    });

    expect(review.runtime).toBe('atomic-js/1');
    expect(review.version).toBe('2.1.0');
    expect(review.name).toBeUndefined();
    expect(review.capabilities).toEqual([
      {
        kind: 'secret',
        title: 'Secret "google"',
        reason: 'Calendar API key. Sent only to https://www.googleapis.com',
      },
      {
        kind: 'operation',
        title: 'GET https://www.googleapis.com/calendar/v3/events',
        reason: 'list-events: reads external data',
      },
    ]);
    expect(grantsFor(review)).toEqual([]);
  });

  it('shows and grants v2 capabilities in either spelling', () => {
    const review = readInstallationReview({
      runtime: 'atomic-js/1',
      world: 'server-extension',
      manifest: {
        schemaVersion: 2,
        capabilities: [
          'custom-view',
          { name: 'storage', reason: 'Caches pages' },
        ],
        network: {
          origins: ['https://api.example'],
          reason: 'Fetches feeds',
        },
      },
    });

    expect(review.world).toBe('server-extension');
    expect(review.capabilities).toEqual([
      {
        kind: 'capability',
        title: 'custom-view',
        reason: undefined,
        grant: 'custom-view',
      },
      {
        kind: 'capability',
        title: 'storage',
        reason: 'Caches pages',
        grant: 'storage',
      },
      {
        kind: 'network',
        title: 'Network access to https://api.example',
        reason: 'Fetches feeds',
      },
    ]);
    expect(grantsFor(review)).toEqual(['custom-view', 'storage']);
  });

  it('tolerates a manifest that is not an object', () => {
    const review = readInstallationReview({
      runtime: 'atomic-js/1',
      manifest: null,
    });
    expect(review.capabilities).toEqual([]);
    expect(review.name).toBeUndefined();
  });
});

describe('installationIdentifier', () => {
  it('produces identifiers the server accepts', () => {
    expect(installationIdentifier('Community fixture')).toBe(
      'Community-fixture',
    );
    expect(installationIdentifier('  --Ünïcode plugin!  ')).toBe(
      'n-code-plugin',
    );
    expect(installationIdentifier('')).toBe('plugin');
    expect(installationIdentifier('x'.repeat(200))).toHaveLength(128);
  });
});

describe('installRelease', () => {
  it('commits an active Installation under the drive with the pinned release', async () => {
    const { store, posted } = await testStore();
    const drive = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Team' },
    });
    await drive.save();
    const propertyLookup = vi.spyOn(store, 'getProperty');

    const subject = await installRelease(store, {
      drive: drive.subject,
      release: {
        url: 'https://example.com/releases/blake3:abc',
        id: 'blake3:abc',
      },
      name: 'test-plugin',
      namespace: 'ontola',
      description: 'Renames folders',
      version: '1.0.0',
      config: { folderPrefix: 'My' },
      grants: ['storage'],
    });

    const installation = store.getResourceLoading(subject);
    expect(installation.hasClasses(server.classes.installation)).toBe(true);
    expect(installation.get(core.properties.parent)).toBe(drive.subject);
    expect(installation.get(core.properties.name)).toBe('test-plugin');
    expect(installation.get(server.properties.namespace)).toBe('ontola');
    expect(installation.get(core.properties.description)).toBe(
      'Renames folders',
    );
    expect(installation.get(server.properties.version)).toBe('1.0.0');
    expect(installation.get(server.properties.release)).toBe(
      'https://example.com/releases/blake3:abc',
    );
    expect(installation.get(server.properties.releaseId)).toBe('blake3:abc');
    expect(installation.get(server.properties.installationStatus)).toBe(
      'active',
    );
    expect(installation.get(server.properties.grants)).toEqual(['storage']);
    expect(
      installation
        .getLoroDoc()
        ?.getMap('datatypes')
        .get(server.properties.grants),
    ).toBe('json');
    expect(
      installation
        .getLoroDoc()
        ?.getMap('datatypes')
        .get(server.properties.config),
    ).toBe('json');
    // The test store skips the datatype fetch, so an object value is kept
    // serialized; against a server the JSON datatype keeps it an object.
    const config = installation.get(server.properties.config);
    expect(typeof config === 'string' ? JSON.parse(config) : config).toEqual({
      folderPrefix: 'My',
    });
    expect(posted.map(c => c.subject)).toContain(subject);
    // Installation must not require the public ontology site to serve these
    // built-in Property URLs; the server validates the signed commit.
    expect(propertyLookup).not.toHaveBeenCalledWith(server.properties.release);
    expect(propertyLookup).not.toHaveBeenCalledWith(
      server.properties.releaseId,
    );
  });

  it('leaves optional fields off and honours a draft status', async () => {
    const { store } = await testStore();
    const subject = await installRelease(store, {
      drive: 'https://example.com/drive',
      release: {
        url: 'https://marketplace.example/release/1',
        id: 'blake3:def',
      },
      name: 'importer',
      grants: [],
      status: 'draft',
    });
    const installation = store.getResourceLoading(subject);
    expect(installation.get(server.properties.installationStatus)).toBe(
      'draft',
    );
    expect(installation.get(server.properties.release)).toBe(
      'https://marketplace.example/release/1',
    );
    expect(installation.get(server.properties.namespace)).toBeUndefined();
    expect(installation.get(server.properties.config)).toBeUndefined();
    expect(installation.get(server.properties.grants)).toEqual([]);
  });
});

describe('updateInstallationRelease', () => {
  it('repoints the same Installation and keeps its identity and name', async () => {
    const { store, posted } = await testStore();
    const drive = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Team' },
    });
    await drive.save();

    const subject = await installRelease(store, {
      drive: drive.subject,
      release: {
        url: 'https://example.com/releases/blake3:one',
        id: 'blake3:one',
      },
      name: 'test-plugin',
      namespace: 'ontola',
      version: '1.0.0',
      config: { folderPrefix: 'My' },
      grants: ['storage'],
    });

    const beforeUpdate = posted.length;
    const propertyLookup = vi.spyOn(store, 'getProperty');
    await updateInstallationRelease(store, subject, {
      release: {
        url: 'https://example.com/releases/blake3:two',
        id: 'blake3:two',
      },
      grants: ['storage', 'custom-view'],
      version: '1.1.0',
    });

    const installation = store.getResourceLoading(subject);
    expect(installation.get(server.properties.release)).toBe(
      'https://example.com/releases/blake3:two',
    );
    expect(installation.get(server.properties.releaseId)).toBe('blake3:two');
    expect(installation.get(server.properties.grants)).toEqual([
      'storage',
      'custom-view',
    ]);
    expect(
      installation
        .getLoroDoc()
        ?.getMap('datatypes')
        .get(server.properties.grants),
    ).toBe('json');
    expect(installation.get(server.properties.version)).toBe('1.1.0');
    // An update is not a new install: same resource, same identifiers, and the
    // config it was running is untouched when the caller passes none.
    expect(installation.get(core.properties.name)).toBe('test-plugin');
    expect(installation.get(server.properties.namespace)).toBe('ontola');
    expect(installation.get(server.properties.installationStatus)).toBe(
      'active',
    );
    const config = installation.get(server.properties.config);
    expect(typeof config === 'string' ? JSON.parse(config) : config).toEqual({
      folderPrefix: 'My',
    });
    // One commit, not one per property: the server checks the grants against
    // the new release's manifest, so a release that arrived on its own could be
    // refused for capabilities the next commit was about to approve.
    expect(posted.length - beforeUpdate).toBe(1);
    expect(propertyLookup).not.toHaveBeenCalledWith(server.properties.release);
    expect(propertyLookup).not.toHaveBeenCalledWith(
      server.properties.releaseId,
    );
  });
});

describe('a release the server’s plugin-routes gates refuse', () => {
  const problem = {
    type: 'host-feature-unavailable',
    feature: 'plugin-routes',
    needed: 'read-only',
    compiled: true,
    level: 'off',
    surfaces: ['route `GET /users/{name}`'],
    listeners: [],
    sidecars: [],
  } as const;
  const message =
    'This plugin opens public endpoints on the server (route `GET /users/{name}`). The server operator hasn’t enabled them.';
  // The `/commit` Error resource the server answers a refused commit with.
  const refusal = () =>
    new AtomicError(
      JSON.stringify({
        [core.properties.description]:
          message +
          PROBLEM_MARKER +
          JSON.stringify({ ...problem, detail: message }),
        'https://atomicdata.dev/properties/errorCode': 11,
      }),
      ErrorType.Client,
    );

  it('throws the typed error from a refused install and forgets the Installation', async () => {
    const { store, postCommitSpy } = await testStore();
    postCommitSpy.mockRejectedValue(refusal());

    const error = await installRelease(store, {
      drive: 'https://example.com/drive',
      release: { url: 'https://example.com/releases/x', id: 'blake3:x' },
      name: 'gated',
      grants: [],
    }).catch(e => e);

    expect(error).toBeInstanceOf(HostFeatureUnavailableError);
    expect(error.problem).toEqual(problem);
    // Nothing is left to install it later, unreviewed.
    expect(store.outbox.pending()).toEqual([]);
  });

  it('throws the typed error from a refused upgrade', async () => {
    const { store, postCommitSpy } = await testStore();
    const subject = await installRelease(store, {
      drive: 'https://example.com/drive',
      release: { url: 'https://example.com/releases/one', id: 'blake3:one' },
      name: 'plain',
      grants: [],
    });
    postCommitSpy.mockRejectedValue(refusal());

    const error = await updateInstallationRelease(store, subject, {
      release: { url: 'https://example.com/releases/two', id: 'blake3:two' },
      grants: [],
    }).catch(e => e);

    expect(error).toBeInstanceOf(HostFeatureUnavailableError);
    expect(error.problem).toEqual(problem);
  });

  it('passes any other refusal through', async () => {
    const { store, postCommitSpy } = await testStore();
    postCommitSpy.mockRejectedValue(new AtomicError('No write right'));

    const error = await installRelease(store, {
      drive: 'https://example.com/drive',
      release: { url: 'https://example.com/releases/x', id: 'blake3:x' },
      name: 'gated',
      grants: [],
    }).catch(e => e);

    expect(error).toBeInstanceOf(AtomicError);
    expect(error.message).toBe('No write right');
  });
});

describe('publishZipRelease', () => {
  it('posts the signed zip bytes to /plugin-release-package for the drive', async () => {
    const { store } = await testStore();
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'blake3:zip',
            subject: 'https://example.com/releases/blake3:zip',
            release: {
              runtime: 'wasip2/1',
              package: 'ab'.repeat(32),
              manifest: { name: 'test-plugin', namespace: 'ontola' },
            },
          }),
          { status: 200 },
        ),
    );

    const result = await publishZipRelease(
      store,
      'did:ad:drive',
      new Blob([bytes]),
      {},
      transport as unknown as typeof fetch,
    );

    expect(result.id).toBe('blake3:zip');
    // The Installation's `release` points at this, not at the id.
    expect(result.subject).toBe('https://example.com/releases/blake3:zip');
    expect(result.release.manifest).toEqual({
      name: 'test-plugin',
      namespace: 'ontola',
    });
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/plugin-release-package');
    expect(parsed.searchParams.get('drive')).toBe('did:ad:drive');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/zip');
    expect(headers['x-atomic-signature']).toBeTruthy();
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  it('surfaces the server error body', async () => {
    const { store } = await testStore();
    const transport = vi.fn(
      async () => new Response('Body is not a zip archive', { status: 400 }),
    );
    await expect(
      publishZipRelease(
        store,
        'did:ad:drive',
        new Blob([]),
        {},
        transport as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Body is not a zip archive');
  });
});
