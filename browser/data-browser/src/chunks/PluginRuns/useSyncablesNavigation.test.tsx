// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { core, type Resource } from '@tomic/react';
import { sourceKey } from './builtinSyncIdentity.js';
import { useSyncablesNavigation } from './useSyncablesNavigation';

const state = vi.hoisted(() => ({
  drive: 'atomic:drive',
  lookup: vi.fn(),
  listeners: new Set<() => void>(),
}));
const store = { getDrive: () => state.drive };
vi.mock('@tomic/react', async original => {
  const React = await import('react');

  return {
    ...(await original<typeof import('@tomic/react')>()),
    useStore: () => store,
    findSchema: (...args: unknown[]) => state.lookup(...args),
    useValue: (resource: Resource, property: string) => [
      React.useSyncExternalStore(
        callback => {
          state.listeners.add(callback);

          return () => {
            state.listeners.delete(callback);
          };
        },
        () => resource.get(property),
        () => resource.get(property),
      ),
    ],
  };
});

const KEY = 'atomic:source-key';
const oldKey = JSON.stringify({
  version: 2,
  kind: 'collection',
  proxyOrigin: 'https://proxy.example',
  platform: 'calendar-service',
  principal: { kind: 'public' },
  collection: { name: 'Events', resource: 'events' },
});
const currentKey = sourceKey({
  version: 3,
  kind: 'collection',
  proxyOrigin: 'https://proxy.example',
  platform: 'calendar-service',
  principal: { kind: 'public' },
  resource: 'events',
});
const resource = (props: Record<string, unknown>) =>
  ({
    subject: 'atomic:table',
    get: (property: string) => {
      if (typeof property !== 'string') throw new Error('Invalid property');

      return props[property];
    },
  }) as unknown as Resource;

afterEach(() => {
  cleanup();
  state.drive = 'atomic:drive';
  state.lookup.mockReset();
  state.listeners.clear();
});

it('keeps an adopted collection closed while resolving metadata and reacts to an in-place source-key change', async () => {
  let release!: (terms: object) => void;
  state.lookup.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const props = {
    [core.properties.localId]: 'syncables:node:' + encodeURIComponent(oldKey),
    [KEY]: oldKey,
  };
  const table = resource(props);
  const { result } = renderHook(() => useSyncablesNavigation(table));
  expect(result.current).toEqual({ loading: true, isDirectory: false });
  await act(async () => {
    release({ properties: { 'syncable-source-key': KEY } });
  });
  await waitFor(() =>
    expect(result.current).toEqual({ loading: false, isDirectory: true }),
  );
  await act(async () => {
    props[KEY] = currentKey;
    state.listeners.forEach(notify => notify());
  });
  expect(result.current).toEqual({ loading: false, isDirectory: false });
  expect(state.lookup).toHaveBeenCalledTimes(1);
});

it('does not look up metadata for ordinary resources or fresh canonical collection IDs', () => {
  for (const localId of [
    'ordinary-table',
    'syncables:node:' + encodeURIComponent(currentKey),
  ]) {
    const { result, unmount } = renderHook(() =>
      useSyncablesNavigation(resource({ [core.properties.localId]: localId })),
    );
    expect(result.current).toEqual({ loading: false, isDirectory: false });
    unmount();
  }

  expect(state.lookup).not.toHaveBeenCalled();
});

it('retains a legacy directory when saved schema metadata is unavailable', async () => {
  state.lookup.mockRejectedValue(new Error('Offline ontology'));
  const table = resource({
    [core.properties.localId]: 'syncables:node:' + encodeURIComponent(oldKey),
  });
  const { result } = renderHook(() => useSyncablesNavigation(table));
  await waitFor(() =>
    expect(result.current).toEqual({ loading: false, isDirectory: true }),
  );
});
