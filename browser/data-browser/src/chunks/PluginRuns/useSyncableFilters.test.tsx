// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { core, dataBrowser, type Resource } from '@tomic/react';
import { readSelectionKey } from 'syncables/browser';
import { entityTableKey, ruleSourceKey } from './builtinSyncIdentity.js';
import { useSyncableFilters } from './useSyncableFilters';
const state = vi.hoisted(() => ({
  viewReady: true,
  search: {} as { view?: string; syncFilter?: string },
  values: new Map<string, Record<string, unknown>>(),
  listeners: new Map<string, () => void>(),
}));
const p = {
  'syncable-source-config': 'atomic:config',
  'syncable-rule-memberships': 'atomic:memberships',
  'syncable-source-key': 'atomic:key',
};
const resource = (subject: string): Resource =>
  ({
    subject,
    get: (prop: string) => {
      if (typeof prop !== 'string')
        throw new Error('Property identifiers must be strings');

      return state.values.get(subject)?.[prop];
    },
    hasClasses: (klass: string) =>
      (
        (state.values.get(subject)?.[core.properties.isA] as string[]) ?? []
      ).includes(klass),
    isReady: () => true,
  }) as unknown as Resource;
vi.mock('../../routes/ShowRoute', () => ({
  ShowRoute: { useSearch: () => state.search },
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useResourceSnapshot: (subject: string) => ({
    resource: resource(subject),
    ready: state.viewReady,
  }),
  useStore: () => store,
  useArray: (row: Resource, property: string) => [row.get(property) ?? []],
  findSchema: async () => ({ properties: p }),
}));
const store = {
  getDrive: () => 'atomic:drive',
  driveOfSubject: () => 'atomic:drive',
  getResource: async (subject: string) => resource(subject),
  subscribe: (subject: string, callback: () => void) => {
    state.listeners.set(subject, callback);

    return () => state.listeners.delete(subject);
  },
};
afterEach(() => {
  cleanup();
  state.values.clear();
  state.listeners.clear();
  state.search = {};
  state.viewReady = true;
});

function setup() {
  const definition = {
    version: 1 as const,
    resource: 'workspace',
    source: {
      kind: 'bound' as const,
      bound: {
        collection: 'workspaces',
        resource: 'workspace',
        path: '/workspaces',
        method: 'GET' as const,
        pathParams: {},
        query: {},
        body: {},
      },
    },
  };
  state.values.set('atomic:table', {
    [core.properties.localId]: 'syncables:node:fixture',
    [dataBrowser.properties.tableViews]: ['atomic:collection', 'atomic:rule'],
    [p['syncable-source-config']]: {
      version: 3,
      kind: 'collection',
      proxyOrigin: 'https://proxy.example',
      platform: 'tracker',
      principal: { kind: 'public' },
      resource: 'workspace',
    },
  });
  state.values.set('atomic:rule', {
    [core.properties.parent]: 'atomic:table',
    [core.properties.isA]: [dataBrowser.classes.view],
    [p['syncable-source-config']]: {
      version: 3,
      kind: 'rule',
      resource: 'workspace',
      definition,
      ruleKey: readSelectionKey(definition),
    },
  });
  const tableKey = entityTableKey({
    proxyOrigin: 'https://proxy.example',
    platform: 'tracker',
    principal: { kind: 'public' },
    resource: 'workspace',
  });
  state.values.get('atomic:table')![p['syncable-source-key']] = tableKey;
  const ruleKey = ruleSourceKey(tableKey, readSelectionKey(definition));
  state.values.get('atomic:rule')![p['syncable-source-key']] = ruleKey;
  state.values.get('atomic:rule')![core.properties.localId] =
    'syncables:node:' + encodeURIComponent(ruleKey);

  return resource('atomic:table');
}

it('selects a saved scope across renderer tabs and fails closed on a foreign filter', async () => {
  const table = setup();
  state.search = { view: 'atomic:rule' };
  const { result, rerender } = renderHook(() => useSyncableFilters(table));
  await waitFor(() =>
    expect(result.current.selected?.resource.subject).toBe('atomic:rule'),
  );
  state.search = { view: 'atomic:sync', syncFilter: 'atomic:rule' };
  rerender();
  expect(result.current.selected?.resource.subject).toBe('atomic:rule');
  state.search = { view: 'atomic:collection', syncFilter: 'atomic:foreign' };
  rerender();
  expect(result.current.ready).toBe(false);
  expect(result.current.error).toContain('unavailable');
  state.search = { view: 'atomic:collection' };
  rerender();
  expect(result.current.ready).toBe(true);
  expect(result.current.selected).toBeUndefined();
});
it('removes detached or edited invalid rules from selectable scopes without provider traffic', async () => {
  const table = setup();
  state.search = { syncFilter: 'atomic:rule' };
  const { result } = renderHook(() => useSyncableFilters(table));
  await waitFor(() => expect(result.current.ready).toBe(true));
  state.values.get('atomic:rule')![core.properties.parent] =
    'atomic:other-table';
  state.listeners.get('atomic:rule')!();
  await waitFor(() => expect(result.current.ready).toBe(false));
  expect(result.current.rules).toHaveLength(0);
});

it('does not widen an implicit malformed rule link into all cached rows', async () => {
  const table = setup();
  state.search = { view: 'atomic:rule' };
  state.values.get('atomic:rule')![p['syncable-source-config']] = {
    version: 3,
    kind: 'rule',
    resource: 'workspace',
    ruleKey: 'tampered',
  };
  const { result } = renderHook(() => useSyncableFilters(table));
  await waitFor(() => expect(result.current.error).toContain('unavailable'));
  expect(result.current.ready).toBe(false);
  expect(result.current.requested).toBe('atomic:rule');
});

it('leaves ordinary tables usable without looking up a missing Sync property', async () => {
  state.values.set('atomic:ordinary', {
    [core.properties.localId]: 'items',
    [dataBrowser.properties.tableViews]: [],
  });
  const table = resource('atomic:ordinary');
  const { result } = renderHook(() => useSyncableFilters(table));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.flat).toBe(false);
  expect(result.current.error).toBeUndefined();
});

it('starts the cached query when the selected view finishes loading on cold entry', async () => {
  const table = setup();
  state.search = { view: 'atomic:collection', syncFilter: 'atomic:rule' };
  state.viewReady = false;
  const { result, rerender } = renderHook(() => useSyncableFilters(table));
  await waitFor(() =>
    expect(result.current.selected?.resource.subject).toBe('atomic:rule'),
  );
  expect(result.current.ready).toBe(false);
  state.viewReady = true;
  rerender();
  expect(result.current.ready).toBe(true);
});

it('recognizes a proven flat collection after preserving an opaque historical local ID', async () => {
  const table = setup();
  state.values.get(table.subject)![core.properties.localId] =
    'original-user-table-id';
  const { result } = renderHook(() => useSyncableFilters(table));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.flat).toBe(true);
  expect(result.current.rules).toHaveLength(1);
});
