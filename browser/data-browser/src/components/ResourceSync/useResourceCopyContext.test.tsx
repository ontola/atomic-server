// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Resource } from '@tomic/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useResourceCopyContext } from './useResourceCopyContext';

const state = vi.hoisted(() => ({
  identity: 'atomic:agent:one',
  account: vi.fn(),
  summary: vi.fn(),
  identityListeners: new Set<() => void>(),
  sessionListeners: new Set<() => void>(),
  logoutListeners: new Set<() => void>(),
}));
const store = {
  getAgent: () => ({ subject: state.identity }),
  serverConnected: true,
  driveOfSubject: (subject: string) => `drive:${subject}`,
  on: (event: string, callback: () => void) => {
    if (event === 'agent') state.identityListeners.add(callback);

    return () => state.identityListeners.delete(callback);
  },
};
vi.mock('@tomic/react', () => ({
  useStore: () => store,
  StoreEvents: { AgentChanged: 'agent', ConnectionChanged: 'connection' },
}));
vi.mock('../../helpers/browserPeerSync', () => ({
  PEER_LINK_CHANGED: 'peer-change',
  peerLinkStatus: () => '',
}));
vi.mock('../../helpers/managed/api', () => ({ hasManagedApi: () => true }));
vi.mock('../../helpers/managed/vault', () => ({
  getVaultDriveSummary: (...args: unknown[]) => state.summary(...args),
}));
vi.mock('../../helpers/managed/vaultAutoBackup', () => ({
  onVaultChanged: () => () => {},
}));
vi.mock('../../helpers/managed/session', () => ({
  getManagedAccountOrNull: () => state.account(),
  onManagedSessionChanged: (callback: () => void) => {
    state.sessionListeners.add(callback);

    return () => state.sessionListeners.delete(callback);
  },
  onManagedLogout: (callback: () => void) => {
    state.logoutListeners.add(callback);

    return () => state.logoutListeners.delete(callback);
  },
}));
const target = { subject: 'atomic:resource:one' } as Resource;
const backup = { enabled: true, suspended: false, last_backup_at: 123 };
beforeEach(() => {
  state.identity = 'atomic:agent:one';
  state.account.mockReset().mockResolvedValue(null);
  state.summary.mockReset().mockResolvedValue(backup);
});
afterEach(() => {
  cleanup();
  state.identityListeners.clear();
  state.sessionListeners.clear();
  state.logoutListeners.clear();
});

it('does not disclose the drive to a configured provider without an account', async () => {
  const hook = renderHook(() => useResourceCopyContext(target));
  await waitFor(() => expect(hook.result.current.vault).toBe('unknown'));
  expect(state.account).toHaveBeenCalledTimes(1);
  expect(state.summary).not.toHaveBeenCalled();
});

it('loads account-only drive metadata after confirming a signed-in account', async () => {
  state.account.mockResolvedValue({ email: 'acct_test' });
  const hook = renderHook(() => useResourceCopyContext(target));
  await waitFor(() => expect(hook.result.current.vault).toBe('enabled'));
  expect(state.summary).toHaveBeenCalledWith(`drive:${target.subject}`);
  expect(state.account.mock.invocationCallOrder[0]).toBeLessThan(
    state.summary.mock.invocationCallOrder[0],
  );
  expect(hook.result.current.lastBackupAt).toBe(123);
});

it.each(['logout', 'identity', 'resource', 'session', 'unmount'] as const)(
  'does not start a stale drive query after %s while account lookup is pending',
  async event => {
    const pending = Promise.withResolvers<{ email: string }>();
    state.account.mockImplementationOnce(() => pending.promise);
    const hook = renderHook(
      ({ resource }) => useResourceCopyContext(resource),
      { initialProps: { resource: target } },
    );
    await act(async () => {
      if (event === 'logout')
        state.logoutListeners.forEach(callback => callback());
      if (event === 'session')
        state.sessionListeners.forEach(callback => callback());

      if (event === 'identity') {
        state.identity = 'atomic:agent:two';
        state.identityListeners.forEach(callback => callback());
      }

      if (event === 'resource')
        hook.rerender({
          resource: { subject: 'atomic:resource:two' } as Resource,
        });
      if (event === 'unmount') hook.unmount();
    });
    await act(async () => pending.resolve({ email: 'acct_old' }));
    expect(state.summary).not.toHaveBeenCalled();
    if (event !== 'unmount') expect(hook.result.current.vault).toBe('unknown');
  },
);

it.each(['logout', 'identity', 'resource', 'session'] as const)(
  'does not restore stale drive metadata after %s while the summary is pending',
  async event => {
    const pending = Promise.withResolvers<typeof backup>();
    state.account.mockResolvedValueOnce({ email: 'acct_test' });
    state.summary.mockImplementationOnce(() => pending.promise);
    const hook = renderHook(
      ({ resource }) => useResourceCopyContext(resource),
      { initialProps: { resource: target } },
    );
    await waitFor(() => expect(state.summary).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (event === 'logout')
        state.logoutListeners.forEach(callback => callback());
      if (event === 'session')
        state.sessionListeners.forEach(callback => callback());

      if (event === 'identity') {
        state.identity = 'atomic:agent:two';
        state.identityListeners.forEach(callback => callback());
      }

      if (event === 'resource')
        hook.rerender({
          resource: { subject: 'atomic:resource:two' } as Resource,
        });
    });
    await act(async () => pending.resolve(backup));
    expect(hook.result.current.vault).toBe('unknown');
    expect(hook.result.current.lastBackupAt).toBeNull();
  },
);
