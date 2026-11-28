import { afterEach, expect, it, vi } from 'vitest';
import { core, Datatype, findSchema, type Store } from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncablePlatform,
  syncablePlatformSchema,
} from './syncablePlatform';
import {
  syncableBranding,
  fetchSyncableDocument,
  storedSyncableDocument,
} from './syncableDocument';

const origin = 'https://proxy.example';
const document = {
  openapi: '3.0.0',
  servers: [{ url: 'https://api.github.com' }],
  paths: {},
};
afterEach(() => vi.restoreAllMocks());

function fixture(source = JSON.stringify(document), selection: unknown = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async url =>
      String(url).endsWith('.yaml')
        ? new Response(source)
        : Response.json(selection),
    );
}

it('loads only fixed public metadata paths without credentials or signatures', async () => {
  const fetch = fixture(
    'openapi: 3.0.0\nservers:\n  - url: https://api.github.com\npaths: {}\n',
    { query_overrides: [] },
  );
  const controller = new AbortController();
  const result = await fetchSyncableDocument(
    origin,
    controller.signal,
    'github-issues',
  );
  expect(result.document).toEqual(document);
  expect(result.querySelection).toEqual({ query_overrides: [] });
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    origin + '/catalog/github-issues.yaml',
    origin + '/catalog/github-issues.selection.json',
  ]);

  for (const [, options] of fetch.mock.calls) {
    expect(options).toEqual({
      signal: expect.any(AbortSignal),
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'application/yaml, application/json' },
    });
  }
});
it('permits missing optional selections, while reporting real catalog failures', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    String(url).endsWith('.yaml')
      ? Response.json(document)
      : new Response('', { status: 404 }),
  );
  expect(
    await fetchSyncableDocument(
      origin,
      new AbortController().signal,
      'github-issues',
    ),
  ).toEqual({ document });
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
  await expect(
    fetchSyncableDocument(
      origin,
      new AbortController().signal,
      'github-issues',
    ),
  ).rejects.toThrow('HTTP 503');
});
it('rejects malformed, oversized and unsafe API documents', async () => {
  const fetch = fixture();

  for (const source of [
    'paths: {}\npaths: {}',
    JSON.stringify({
      ...document,
      servers: [{ url: 'http://public.example' }],
    }),
    JSON.stringify({ paths: {}, servers: [] }),
    'x'.repeat(1_048_577),
  ]) {
    fetch.mockImplementation(async url =>
      String(url).endsWith('.yaml') ? new Response(source) : Response.json({}),
    );
    await expect(
      fetchSyncableDocument(
        origin,
        new AbortController().signal,
        'github-issues',
      ),
    ).rejects.toThrow();
  }
});
it('discards late metadata when its selected execution has been cancelled', async () => {
  const controller = new AbortController();
  fixture();
  const pending = fetchSyncableDocument(
    origin,
    controller.signal,
    'github-issues',
  );
  controller.abort();
  await expect(pending).rejects.toThrow();
});
it('rejects invalid origins before any network request', async () => {
  const fetch = fixture();
  for (const value of [
    'https://proxy.example/path',
    'https://user:password@proxy.example',
    'http://public.example',
    'file:///tmp/catalog',
  ])
    await expect(
      fetchSyncableDocument(
        value,
        new AbortController().signal,
        'github-issues',
      ),
    ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('reads another provider and its declarative branding without a host adapter', async () => {
  const fetch = fixture(
    JSON.stringify({
      ...document,
      info: {
        title: 'Example service',
        'x-logo': { url: 'https://cdn.example/icon.png' },
      },
    }),
  );
  const result = await fetchSyncableDocument(
    origin,
    new AbortController().signal,
    'example-service',
  );
  expect(String(fetch.mock.calls[0][0])).toBe(
    origin + '/catalog/example-service.yaml',
  );
  expect(syncableBranding(result.document)).toEqual({
    name: 'Example service',
    icon: 'https://cdn.example/icon.png',
  });
  expect(
    syncableBranding({ info: { title: '   ', 'x-logo': 'javascript:unsafe' } }),
  ).toEqual({ name: undefined, icon: undefined });
});

it('inherits a descendant’s saved API metadata only through the same installation and drive', async () => {
  const p = Object.fromEntries(
    [
      'syncable-api-document',
      'syncable-api-selection',
      'syncable-platform-id',
      'syncable-proxy-origin',
    ].map(key => [key, key]),
  );
  const nodes: Record<string, Record<string, unknown>> = {
    public: { [core.properties.parent]: 'accounts' },
    accounts: {
      [core.properties.parent]: 'app',
      [p['syncable-api-document']]: document,
      [p['syncable-api-selection']]: { query_overrides: [] },
      [p['syncable-platform-id']]: 'example-service',
      [p['syncable-proxy-origin']]: origin,
    },
    app: { [core.properties.parent]: 'drive' },
  };
  const store = {
    getResource: vi.fn(async (key: string) => ({
      get: (property: string) => nodes[key]?.[property],
    })),
  } as unknown as Store;
  const fetch = vi.spyOn(globalThis, 'fetch');
  const source = {
    platform: 'example-service',
    proxyOrigin: origin,
    schema: { properties: p },
  };
  expect(
    await storedSyncableDocument(store, 'drive', 'public', source),
  ).toEqual({ document, querySelection: { query_overrides: [] } });
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await storedSyncableDocument(store, 'drive', 'public', {
      ...source,
      proxyOrigin: 'https://other.example',
    }),
  ).toEqual({});
  nodes.app['https://atomicdata.dev/properties/drive'] = 'foreign-drive';
  await expect(
    storedSyncableDocument(store, 'drive', 'public', source),
  ).rejects.toThrow('outside');
});

it('rejects platform paths before fetching a catalog document', async () => {
  const fetch = fixture();
  for (const platform of ['../unsafe', 'a/b', 'http:provider'])
    await expect(
      fetchSyncableDocument(origin, new AbortController().signal, platform),
    ).rejects.toThrow('platform ID');
  expect(fetch).not.toHaveBeenCalled();
});

it('reuses installation metadata after a collection moves elsewhere in the same drive', async () => {
  const { store, resources } = fakeSchemaStore();
  resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });
  const app = await ensureSyncablePlatform(store, {
    drive: 'drive',
    proxyOrigin: origin,
    platform: 'example-service',
    name: 'Example',
  });
  const terms = await findSchema(store, 'drive', syncablePlatformSchema());
  const p = terms.properties!;
  await (
    await store.getResource(app)
  ).set(p['syncable-api-document'], document);
  resources.set('folder', { [core.properties.parent]: 'drive' });
  resources.set('moved-collection', { [core.properties.parent]: 'folder' });
  const fetch = vi.spyOn(globalThis, 'fetch');
  const source = {
    platform: 'example-service',
    proxyOrigin: origin,
    schema: { properties: p },
  };
  expect(
    await storedSyncableDocument(
      store as unknown as Store,
      'drive',
      'moved-collection',
      source,
    ),
  ).toEqual({ document, querySelection: undefined });
  expect(fetch).not.toHaveBeenCalled();
  resources.get('folder')![core.properties.parent] = 'another-drive';
  await expect(
    storedSyncableDocument(
      store as unknown as Store,
      'drive',
      'moved-collection',
      source,
    ),
  ).rejects.toThrow('outside');
});
