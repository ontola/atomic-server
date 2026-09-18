import { describe, expect, it, vi } from 'vitest';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import {
  grantsFor,
  installRelease,
  installationIdentifier,
  publishZipRelease,
  readInstallationReview,
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

    const subject = await installRelease(store, {
      drive: drive.subject,
      release: { url: 'blake3:abc', id: 'blake3:abc' },
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
    expect(installation.get(server.properties.release)).toBe('blake3:abc');
    expect(installation.get(server.properties.releaseId)).toBe('blake3:abc');
    expect(installation.get(server.properties.installationStatus)).toBe(
      'active',
    );
    expect(installation.get(server.properties.grants)).toEqual(['storage']);
    // The test store skips the datatype fetch, so an object value is kept
    // serialized; against a server the JSON datatype keeps it an object.
    const config = installation.get(server.properties.config);
    expect(typeof config === 'string' ? JSON.parse(config) : config).toEqual({
      folderPrefix: 'My',
    });
    expect(posted.map(c => c.subject)).toContain(subject);
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

describe('publishZipRelease', () => {
  it('posts the signed zip bytes to /plugin-release-package for the drive', async () => {
    const { store } = await testStore();
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'blake3:zip',
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
