// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Resource, ResourceSyncStatus } from '@tomic/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useResourceCopies } from './useResourceCopies';

const snapshots = new Map<Resource, ResourceSyncStatus>();
const listeners = new Map<Resource, Set<() => void>>();
const unknownDestination = { state: 'unknown' };
const noPeers = {
  state: 'unknown',
  connectedCount: 0,
  confirmedCount: 0,
  peers: [],
};
const noAttachments = {
  required: false,
  local: unknownDestination,
  server: unknownDestination,
  peers: [],
};
const store = {
  getResourcePeerSyncStatus: () => noPeers,
  getResourceAttachmentSyncStatus: () => noAttachments,
  getResourceSyncStatus: (resource: Resource) => snapshots.get(resource)!,
};
vi.mock('@tomic/react', () => ({ useStore: () => store }));
vi.mock('../../helpers/managed/vaultResourceSync', () => ({
  getResourceVaultSyncStatus: () => unknownDestination,
  getResourceVaultAttachmentSyncStatus: () => unknownDestination,
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

beforeEach(() => {
  snapshots.clear();
  listeners.clear();
});
afterEach(cleanup);

it('updates on receipt events without changing unrelated resource status', () => {
  const first = createResource('atomic:first');
  const second = createResource('atomic:second');
  snapshots.set(first, unknown);
  snapshots.set(second, unknown);
  const one = renderHook(() => useResourceCopies(first));
  const two = renderHook(() => useResourceCopies(second));
  const secondBefore = two.result.current;

  act(() => {
    snapshots.set(first, saved);
    listeners.get(first)!.forEach(callback => callback());
  });
  expect(one.result.current.status).toBe(saved);
  expect(two.result.current.status).toBe(unknown);
  expect(two.result.current).toBe(secondBefore);
});

it('switches subscriptions and snapshots when a row is reused for another resource', () => {
  const first = createResource('atomic:first');
  const second = createResource('atomic:second');
  snapshots.set(first, saved);
  snapshots.set(second, unknown);
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
