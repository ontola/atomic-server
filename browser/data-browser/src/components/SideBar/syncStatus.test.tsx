// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook, render } from '@testing-library/react';
import { StoreContext, type Store as PackageStore } from '@tomic/react';
import { Store } from '../../../../lib/src/store';
import type { Agent } from '../../../../lib/src/agent';
import { afterEach, expect, it } from 'vitest';
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
