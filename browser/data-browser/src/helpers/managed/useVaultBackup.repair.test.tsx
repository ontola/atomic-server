// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import { useVaultBackup } from './useVaultBackup';
import {
  agentVaultProof,
  getVaultState,
  listVaultDrives,
  recoverDriveKey,
  restoreDrive,
  type VaultCapableDb,
  type VaultKeyOps,
} from './vault';
import { repairDriveFiles, type FileRepairOutcome } from './vaultFileRepair';
import { getManagedAccount, onManagedLogout } from './session';

vi.mock('./vault', () => ({
  agentVaultProof: vi.fn(),
  getVaultState: vi.fn(),
  listVaultDrives: vi.fn(),
  recoverDriveKey: vi.fn(),
  restoreDrive: vi.fn(),
  getVaultDriveSummary: vi.fn(),
}));
vi.mock('./vaultFileRepair', () => ({ repairDriveFiles: vi.fn() }));
vi.mock('./session', () => ({
  getManagedAccount: vi.fn(),
  onManagedLogout: vi.fn(),
  onManagedSessionChanged: vi.fn(() => () => {}),
}));
vi.mock('./vaultAutoBackup', () => ({
  onVaultChanged: vi.fn(() => () => {}),
  setVaultOptOut: vi.fn(),
}));

const FIRST = 'atomic:drive:first';
const SECOND = 'atomic:drive:second';
const AGENT = 'atomic:agent:alice';
const outcome: FileRepairOutcome = {
  total: 2,
  repaired: 1,
  missing: ['missing'],
  unreadable: 1,
};

function setup() {
  const db = {
    vaultFileHashes: vi.fn(),
    vaultBlobPresent: vi.fn(),
    vaultBlobRestore: vi.fn(),
  } as unknown as VaultCapableDb;
  const state = { drive: FIRST, agent: AGENT, db };
  const retry = vi.fn();
  const store = {
    getAgent: () => ({ subject: state.agent }),
    getDrive: () => state.drive,
    getClientDb: () => state.db,
    on: vi.fn(() => () => {}),
    retryFileContentRecovery: retry,
  } as unknown as Store;
  const keys = {} as VaultKeyOps;
  const signer = { signBytes: vi.fn() };
  const proofMessage = new Uint8Array([1]);
  const tryPeers = vi.fn(async () => {});
  const options = () => ({
    db: state.db,
    keys,
    signer,
    proofMessage,
    devicePubkey: 'device',
    driveSubject: state.drive,
    agentSubject: state.agent,
    store,
    tryPeers,
  });

  return { state, options, tryPeers, retry };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getManagedAccount).mockResolvedValue({
    email: 'alice@example.test',
  });
  vi.mocked(onManagedLogout).mockReturnValue(() => {});
  vi.mocked(agentVaultProof).mockResolvedValue(new Uint8Array([1]));
  const enrollments = [FIRST, SECOND].map(drive => ({
    id: drive,
    drive_subject: drive,
    drive_pseudonym: `vault:${drive}`,
    status: 'active',
    used_bytes: 1,
    quota_bytes: 10,
    last_backup_at: 1,
  }));
  vi.mocked(listVaultDrives).mockResolvedValue(enrollments);
  vi.mocked(getVaultState).mockImplementation(async pseudonym => ({
    enrollment: enrollments.find(item => item.drive_pseudonym === pseudonym)!,
    lanes: {},
    checkpoints: [],
    pending_uploads: 0,
    confirmed_objects: 1,
  }));
  vi.mocked(recoverDriveKey).mockResolvedValue({
    driveKey: new Uint8Array(32),
    keyEpoch: 2,
  });
  vi.mocked(repairDriveFiles).mockResolvedValue(outcome);
});

afterEach(cleanup);

it('returns file recovery counts without restoring any resource snapshot', async () => {
  const fixture = setup();
  const hook = renderHook(() => useVaultBackup(fixture.options()));
  await waitFor(() => expect(hook.result.current.canRecoverFiles).toBe(true));

  await act(async () => {
    expect(await hook.result.current.recoverMissingFiles()).toEqual(outcome);
  });

  expect(hook.result.current.fileRecoveryResult).toEqual(outcome);
  expect(repairDriveFiles).toHaveBeenCalledWith(
    expect.objectContaining({
      driveSubject: FIRST,
      drivePseudonym: `vault:${FIRST}`,
      keyEpoch: 2,
      tryPeers: fixture.tryPeers,
    }),
  );
  expect(restoreDrive).not.toHaveBeenCalled();
  expect(fixture.retry).toHaveBeenCalledOnce();
});

it('does not refresh file readers when the scan recovered no bytes', async () => {
  const fixture = setup();
  vi.mocked(repairDriveFiles).mockResolvedValueOnce({
    total: 1,
    repaired: 0,
    missing: ['missing'],
    unreadable: 0,
  });
  const hook = renderHook(() => useVaultBackup(fixture.options()));
  await waitFor(() => expect(hook.result.current.canRecoverFiles).toBe(true));
  await act(async () => {
    await hook.result.current.recoverMissingFiles();
  });
  expect(fixture.retry).not.toHaveBeenCalled();
});

it('cancels an active repair and ignores its eventual result', async () => {
  const fixture = setup();
  const pending = Promise.withResolvers<FileRepairOutcome>();
  vi.mocked(repairDriveFiles).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useVaultBackup(fixture.options()));
  await waitFor(() => expect(hook.result.current.canRecoverFiles).toBe(true));
  let running: Promise<FileRepairOutcome | null>;
  act(() => {
    running = hook.result.current.recoverMissingFiles();
  });
  await waitFor(() => expect(repairDriveFiles).toHaveBeenCalledOnce());
  const request = vi.mocked(repairDriveFiles).mock.calls[0][0];

  act(() => hook.result.current.cancelFileRecovery());
  expect(request.signal?.aborted).toBe(true);
  expect(hook.result.current.busy).toBe(false);
  await act(async () => {
    pending.resolve(outcome);
    await running;
  });

  expect(hook.result.current.fileRecoveryResult).toBeNull();
  expect(fixture.retry).not.toHaveBeenCalled();
  expect(hook.result.current.fileRecoveryError).toBe(
    'File recovery cancelled.',
  );
});

it('aborts when the drive changes and fetches the next drive’s own key', async () => {
  const fixture = setup();
  const pending = Promise.withResolvers<FileRepairOutcome>();
  vi.mocked(repairDriveFiles).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useVaultBackup(fixture.options()));
  await waitFor(() => expect(hook.result.current.canRecoverFiles).toBe(true));
  let running: Promise<FileRepairOutcome | null>;
  act(() => {
    running = hook.result.current.recoverMissingFiles();
  });
  await waitFor(() => expect(repairDriveFiles).toHaveBeenCalledOnce());
  const firstSignal = vi.mocked(repairDriveFiles).mock.calls[0][0].signal;
  fixture.state.drive = SECOND;
  hook.rerender();
  await waitFor(() =>
    expect(hook.result.current.status).toMatchObject({
      state: 'on',
      enrollment: { drive_subject: SECOND },
    }),
  );
  expect(firstSignal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(outcome);
    await running;
  });
  expect(hook.result.current.fileRecoveryResult).toBeNull();
  expect(fixture.retry).not.toHaveBeenCalled();

  await act(async () => {
    await hook.result.current.recoverMissingFiles();
  });
  expect(recoverDriveKey).toHaveBeenLastCalledWith(
    expect.objectContaining({ drivePseudonym: `vault:${SECOND}` }),
  );
  expect(recoverDriveKey).toHaveBeenCalledTimes(2);
});

it('invalidates a running repair on logout without applying late results', async () => {
  const fixture = setup();
  const pending = Promise.withResolvers<FileRepairOutcome>();
  vi.mocked(repairDriveFiles).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useVaultBackup(fixture.options()));
  await waitFor(() => expect(hook.result.current.canRecoverFiles).toBe(true));
  let running: Promise<FileRepairOutcome | null>;
  act(() => {
    running = hook.result.current.recoverMissingFiles();
  });
  await waitFor(() => expect(repairDriveFiles).toHaveBeenCalledOnce());
  const request = vi.mocked(repairDriveFiles).mock.calls[0][0];
  const logout = vi.mocked(onManagedLogout).mock.calls.at(-1)![0];
  act(() => logout());
  expect(request.signal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(outcome);
    await running;
  });
  expect(hook.result.current.fileRecoveryResult).toBeNull();
  expect(fixture.retry).not.toHaveBeenCalled();
});

it('aborts an unfinished repair when its panel unmounts', async () => {
  const fixture = setup();
  const pending = Promise.withResolvers<FileRepairOutcome>();
  vi.mocked(repairDriveFiles).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useVaultBackup(fixture.options()));
  await waitFor(() => expect(hook.result.current.canRecoverFiles).toBe(true));
  let running: Promise<FileRepairOutcome | null>;
  act(() => {
    running = hook.result.current.recoverMissingFiles();
  });
  await waitFor(() => expect(repairDriveFiles).toHaveBeenCalledOnce());
  const request = vi.mocked(repairDriveFiles).mock.calls[0][0];

  hook.unmount();
  expect(request.signal?.aborted).toBe(true);
  pending.resolve(outcome);
  expect(await running!).toBeNull();
});
