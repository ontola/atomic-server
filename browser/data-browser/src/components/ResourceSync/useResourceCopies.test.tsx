// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import type {
  Resource,
  ResourceCopies,
  ResourceSyncStatus,
} from '@tomic/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useResourceCopies } from './useResourceCopies';

const snapshots = new Map<Resource, ResourceCopies>();
const listeners = new Map<Resource, Set<() => void>>();
const unknownDestination = { state: 'unknown' } as const;
const noPeers: ResourceCopies['peers'] = {
  state: 'unknown',
  connectedCount: 0,
  confirmedCount: 0,
  peers: [],
};
const noAttachments: ResourceCopies['contents'] = {
  required: false,
  local: unknownDestination,
  server: unknownDestination,
  peers: [],
};
const store = {
  getResourceCopies: (resource: Resource) => snapshots.get(resource)!,
};
const noVault = { document: unknownDestination, contents: unknownDestination };
vi.mock('@tomic/react', () => ({ useStore: () => store }));
vi.mock('../../helpers/managed/vaultResourceSync', () => ({
  getResourceVaultCopies: () => noVault,
  subscribeResourceCopies: (
    _store: unknown,
    resource: Resource,
    callback: () => void,
  ) => {
    const subscriptions = listeners.get(resource) ?? new Set();
    subscriptions.add(callback);
    listeners.set(resource, subscriptions);

    return () => subscriptions.delete(callback);
  },
}));

function createResource(subject: string): Resource {
  const value = { subject } as Resource;
  Object.defineProperty(value, '__internalObject', { value });

  return value;
}

const unknown: ResourceSyncStatus = {
  local: { state: 'unknown' },
  server: { state: 'unknown', url: 'https://studio.example' },
};
const saved: ResourceSyncStatus = {
  local: { state: 'confirmed' },
  server: { state: 'confirmed', url: 'https://studio.example' },
};
const unknownCopies = {
  status: unknown,
  peers: noPeers,
  contents: noAttachments,
};
const savedCopies = { ...unknownCopies, status: saved };

beforeEach(() => {
  snapshots.clear();
  listeners.clear();
});
afterEach(cleanup);

it('updates on receipt events without changing unrelated resource status', () => {
  const first = createResource('atomic:first');
  const second = createResource('atomic:second');
  snapshots.set(first, unknownCopies);
  snapshots.set(second, unknownCopies);
  const one = renderHook(() => useResourceCopies(first));
  const two = renderHook(() => useResourceCopies(second));
  const secondBefore = two.result.current;

  act(() => {
    snapshots.set(first, savedCopies);
    listeners.get(first)!.forEach(callback => callback());
  });
  expect(one.result.current.status).toBe(saved);
  expect(two.result.current.status).toBe(unknown);
  expect(two.result.current).toBe(secondBefore);
});

it('switches subscriptions and snapshots when a row is reused for another resource', () => {
  const first = createResource('atomic:first');
  const second = createResource('atomic:second');
  snapshots.set(first, savedCopies);
  snapshots.set(second, unknownCopies);
  const hook = renderHook(({ target }) => useResourceCopies(target), {
    initialProps: { target: first },
  });
  expect(hook.result.current.status).toBe(saved);
  hook.rerender({ target: second });

  expect(hook.result.current.status).toBe(unknown);
  expect(listeners.get(first)?.size).toBe(0);
  expect(listeners.get(second)?.size).toBe(1);
  hook.unmount();
  expect(listeners.get(second)?.size).toBe(0);
});
