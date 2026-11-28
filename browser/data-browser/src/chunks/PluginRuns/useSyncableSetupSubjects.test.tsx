// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { core, server } from '@tomic/react';
import { platformLocalId } from './syncablePlatform';
import { useSyncableSetupSubjects } from './useSyncableSetupSubjects';

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  listeners: new Set<() => void>(),
  revision: 0,
  lookup: vi.fn(),
}));
vi.mock('@tomic/react', async original => {
  const React = await import('react');
  const row = (subject: string) => ({
    subject,
    get: (property: string) => state.rows.get(subject)?.[property],
  });

  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);

    return () => {
      state.listeners.delete(listener);
    };
  };

  return {
    ...(await original<typeof import('@tomic/react')>()),
    useStore: () => store,
    useResource: row,
    useValue: (resource: ReturnType<typeof row>, property: string) => [
      React.useSyncExternalStore(
        subscribe,
        () => resource.get(property),
        () => resource.get(property),
      ),
    ],
    useResources: (subjects: string[]) => {
      const revision = React.useSyncExternalStore(
        subscribe,
        () => state.revision,
        () => state.revision,
      );

      return React.useMemo(
        () => new Map(subjects.map(subject => [subject, row(subject)])),
        [subjects, revision],
      );
    },
  };
});
vi.mock('./syncableSetupVisibility', async original => ({
  ...(await original<typeof import('./syncableSetupVisibility')>()),
  syncableSetupVisibilityTerms: (...args: unknown[]) => state.lookup(...args),
}));
const store = { getServerUrl: () => 'https://atomic.example' };
const setup = 'https://atomic.example/setup';
const index = 'property:index';
const role = 'property:setup';
const terms = {
  appClass: 'class:app',
  dataProperty: 'property:data',
  properties: {
    'syncable-platform-index': index,
    'syncable-platform-setup': role,
    'builtin-app': 'property:builtin',
    'syncable-platform-id': 'property:platform',
    'syncable-proxy-origin': 'property:proxy',
  },
};

function notify() {
  state.revision++;
  state.listeners.forEach(listener => listener());
}

afterEach(() => {
  cleanup();
  state.rows.clear();
  state.listeners.clear();
  state.lookup.mockReset();
});

it('discovers metadata installed after drive entry and reacts when a resource becomes a principal App', async () => {
  const localId = platformLocalId('https://proxy.example', 'calendar-service');
  const ontology = {
    [core.properties.properties]: [],
    [core.properties.classes]: [],
  } as Record<string, unknown>;
  const root = { [server.properties.defaultOntology]: 'ontology' } as Record<
    string,
    unknown
  >;
  const app = {
    [core.properties.isA]: [terms.appClass],
    [core.properties.localId]: localId,
    [terms.dataProperty]: setup,
    [role]: true,
    'property:builtin': 'syncables',
    'property:platform': 'calendar-service',
    'property:proxy': 'https://proxy.example',
  };
  state.rows.set('drive', root);
  state.rows.set('ontology', ontology);
  state.rows.set(setup, app);
  state.lookup.mockResolvedValue({ properties: {} });
  const { result } = renderHook(() => useSyncableSetupSubjects('drive'));
  await waitFor(() => expect(state.lookup).toHaveBeenCalledTimes(1));
  expect(result.current.size).toBe(0);
  state.lookup.mockResolvedValue(terms);
  await act(async () => {
    root[index] = { [localId]: setup };
    ontology[core.properties.properties] = [index];
    notify();
  });
  await waitFor(() => expect(result.current.has(setup)).toBe(true));
  await act(async () => {
    app[role] = false;
    notify();
  });
  expect(result.current.size).toBe(0);
});
