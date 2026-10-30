// @vitest-environment jsdom
// @wc-ignore-file
import {
  act,
  cleanup,
  renderHook,
  render,
  waitFor,
} from '@testing-library/react';
import { StoreContext, type Store as PackageStore } from '@tomic/react';
import { Store } from '../../../../lib/src/store';
import { Resource } from '../../../../lib/src/resource';
import { testStore } from '../../../../lib/src/test-store';
import { core } from '../../../../lib/src/ontologies/core';
import * as tauriHelpers from '../../helpers/tauri';
import type { Agent } from '../../../../lib/src/agent';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('loro-crdt/web', () => import('loro-crdt/nodejs'));
import { ThemeProvider } from 'styled-components';
import {
  getSyncIcon,
  getSyncLabel,
  hasSyncWarning,
  useSyncStatus,
} from './syncStatus';

const A = 'atomic:resource:drive-a';
const B = 'atomic:resource:drive-b';
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function mounted() {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  const hook = renderHook(() => useSyncStatus(), {
    wrapper: ({ children }) => (
      <StoreContext.Provider value={store as unknown as PackageStore}>
        {children}
      </StoreContext.Provider>
    ),
  });

  return { store, hook };
}

it('tracks local-only registration and promotion while the server is connected', () => {
  const { store, hook } = mounted();
  act(() => {
    store.setDrive(A);
    store.setServerConnected(true);
    store.finishDriveSync(A, 1, 10);
  });
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
  act(() => store.registerLocalOnlyDrive(A));
  expect(getSyncLabel(hook.result.current)).toBe('Not syncing with a server');
  expect(hasSyncWarning(hook.result.current)).toBe(false);
  const icon = render(
    <ThemeProvider
      theme={{ colors: { alert: 'red', warning: 'orange' } } as never}
    >
      {getSyncIcon(hook.result.current)}
    </ThemeProvider>,
  );
  expect(icon.getByTitle('Not syncing with a server')).toBeTruthy();
  act(() => store.unregisterLocalOnlyDrive(A));
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
  expect(hasSyncWarning(hook.result.current)).toBe(false);
});

it('requires the selected drive receipt and handles foreign and absent drives', () => {
  const { store, hook } = mounted();
  act(() => {
    store.setDrive(A);
    store.setServerConnected(true);
    store.finishDriveSync(B, 1, 10);
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
  act(() => store.finishDriveSync(A, 1, 20));
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
  act(() => store.setDrive(B));
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
  act(() => store.setDrive('https://other.example/drive'));
  expect(getSyncLabel(hook.result.current)).toBe('Not syncing with a server');
  act(() => store.setDrive(''));
  expect(getSyncLabel(hook.result.current)).toBe('Not syncing with a server');
});

it('clears receipts on server or identity changes, but preserves them for no-ops', () => {
  const { store, hook } = mounted();
  const alice = { subject: 'atomic:agent:alice' } as Agent;
  const bob = { subject: 'atomic:agent:bob' } as Agent;
  act(() => {
    store.setAgent(alice);
    store.setDrive(A);
    store.setServerConnected(true);
    store.finishDriveSync(A, 1, 10);
  });
  act(() => {
    store.setServerUrl('https://example.com', { connect: false });
    store.setAgent(alice);
  });
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
  act(() => {
    store.setServerUrl('https://new.example', { connect: false });
    store.setServerConnected(true);
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
  expect(store.hasCompletedDriveSyncFor(A)).toBe(false);
  act(() => store.finishDriveSync(A, 1, 20));
  act(() => {
    store.setAgent(bob);
    store.setDrive(A);
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
  expect(store.hasCompletedDriveSyncFor(A)).toBe(false);
});

it('preserves offline, syncing, queued and blocked priority', () => {
  const { store, hook } = mounted();
  act(() => store.setDrive(A));
  expect(getSyncLabel(hook.result.current)).toBe('Offline');
  act(() => {
    store.setServerConnected(true);
    store.startDriveSync();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Syncing...');
  act(() => store.finishDriveSync(A, 1, 10));
  const status = hook.result.current;
  expect(getSyncLabel({ ...status, pendingDirtyCount: 2 })).toBe(
    '2 changes pending',
  );
  expect(hasSyncWarning({ ...status, pendingDirtyCount: 2 })).toBe(true);
  expect(
    getSyncLabel({ ...status, blockedCount: 1, pendingDirtyCount: 2 }),
  ).toBe('1 changes could not sync (no access)');
  expect(hasSyncWarning({ ...status, blockedCount: 1 })).toBe(true);
});

it('uses the alert color for every state without confirmed current data', () => {
  const { store, hook } = mounted();
  act(() => {
    store.setDrive(A);
    store.setServerConnected(true);
  });
  const base = hook.result.current;

  for (const status of [
    base,
    { ...base, syncInProgress: true },
    { ...base, pendingDirtyCount: 1 },
    { ...base, blockedCount: 1 },
  ]) {
    const icon = render(
      <ThemeProvider
        theme={{ colors: { alert: 'red', warning: 'orange' } } as never}
      >
        {getSyncIcon(status)}
      </ThemeProvider>,
    );
    expect(getComputedStyle(icon.container.firstElementChild!).color).toBe(
      'rgb(255, 0, 0)',
    );
    icon.unmount();
  }
});

it('turns red immediately for an unsaved edit after a completed sync', () => {
  const { store, hook } = mounted();
  const resource = new Resource(A);
  resource.setStore(store);
  store.addResource(resource);
  act(() => {
    store.setDrive(A);
    store.setServerConnected(true);
    store.finishDriveSync(A, 1, 10);
  });
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
  act(() => resource.markDirty());
  expect(getSyncLabel(hook.result.current)).not.toBe('Synced with server');
});

it('stays red when a later edit arrives while an earlier save awaits acknowledgement', async () => {
  const { store, postCommitSpy } = await testStore();
  const resource = await store.newResource({
    noParent: true,
    propVals: { [core.properties.name]: 'initial' },
  });
  await resource.save();
  store.setDrive(resource.subject);
  store.finishDriveSync(resource.subject, 1, 10);
  const hook = renderHook(() => useSyncStatus(), {
    wrapper: ({ children }) => (
      <StoreContext.Provider value={store as unknown as PackageStore}>
        {children}
      </StoreContext.Provider>
    ),
  });
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
  const acknowledgements: Array<() => void> = [];
  postCommitSpy.mockImplementation(
    commit =>
      new Promise(resolve => {
        acknowledgements.push(() =>
          resolve({
            ...commit,
            id: `https://example.com/commits/${commit.signature}`,
          }),
        );
      }),
  );
  await act(async () => {
    await resource.set(core.properties.name, 'first', false);
  });
  let saving!: Promise<unknown>;
  act(() => {
    saving = resource.save();
  });
  await waitFor(() => expect(acknowledgements).toHaveLength(1));
  await act(async () => {
    await resource.set(core.properties.name, 'second', false);
  });
  await act(async () => {
    acknowledgements[0]();
    await Promise.resolve();
  });
  expect(getSyncLabel(hook.result.current)).not.toBe('Synced with server');
  await waitFor(() => expect(acknowledgements).toHaveLength(2));
  await act(async () => {
    acknowledgements[1]();
    await saving;
  });
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
});

it('tracks resources added after mounting and releases removed resources', () => {
  const { store, hook } = mounted();
  act(() => {
    store.setDrive(A);
    store.setServerConnected(true);
    store.finishDriveSync(A, 1, 10);
  });
  const resource = new Resource(A);
  act(() => {
    store.addResource(resource);
    resource.markDirty();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Changes not yet synced');
  act(() => store.removeResource(A));
  expect(getSyncLabel(hook.result.current)).toBe('Synced with server');
});

it('does not count the embedded desktop server as another place', () => {
  const tauri = vi
    .spyOn(tauriHelpers, 'isRunningInTauri')
    .mockReturnValue(true);
  const store = new Store({
    serverUrl: 'http://localhost:9883',
    connect: false,
  });
  store.setDrive(A);
  store.setServerConnected(true);
  store.finishDriveSync(A, 1, 10);
  const hook = renderHook(() => useSyncStatus(), {
    wrapper: ({ children }) => (
      <StoreContext.Provider value={store as unknown as PackageStore}>
        {children}
      </StoreContext.Provider>
    ),
  });
  expect(getSyncLabel(hook.result.current)).toBe('Not syncing with a server');
  tauri.mockRestore();
});
