// @vitest-environment jsdom
// @wc-ignore-file
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDriveVault } from './useDriveVault';
import { getManagedEnrollments } from './enrollmentApi';

const DRIVE = 'did:ad:drive';
const restoreOutcome = {
  packsRead: 1,
  objectsSkipped: 0,
  objectsUnreadable: 0,
  resourcesRestored: 3,
  tombstonesApplied: 0,
};

const store = {
  getAgent: () => ({ subject: 'did:ad:agent:x' }),
  getClientDb: () => null,
  normalizeSubject: (s: string) => s,
  registerLocalOnlyDrive: vi.fn(),
  reloadResource: vi.fn(async () => undefined),
  getServerUrl: () => 'https://node1.example',
};

vi.mock('@tomic/react', () => ({ useStore: () => store }));
vi.mock('./useVaultBackup', () => ({
  useVaultBackup: () => ({ restore: async () => restoreOutcome }),
}));
vi.mock('./vaultKeyOps', () => ({
  loadVaultKeyOps: async () => {
    throw new Error('no wasm');
  },
}));
vi.mock('./enrollmentApi', () => ({ getManagedEnrollments: vi.fn() }));
// A node-backed origin, like the managed node1 in the bug report.
vi.mock('../originNode', () => ({ isOriginWithoutNode: () => false }));

/**
 * The "Restore from Cloud Vault" button. Restoring a drive no Cloud Server
 * hosts used to leave it unregistered, so the connected managed node refused
 * every write ("not enrolled for sync on this node").
 */
describe('useDriveVault restore', () => {
  beforeEach(() => {
    store.registerLocalOnlyDrive.mockClear();
  });

  const restore = async () => {
    const { result } = renderHook(() => useDriveVault(DRIVE));

    await result.current.restore();
  };

  it('keeps a restored drive that nothing hosts on this device', async () => {
    vi.mocked(getManagedEnrollments).mockResolvedValue([]);
    await restore();
    expect(store.registerLocalOnlyDrive).toHaveBeenCalledWith(DRIVE);
  });

  it('leaves a hosted drive on its node', async () => {
    vi.mocked(getManagedEnrollments).mockResolvedValue([
      { drive_subject: DRIVE, agent_subject: null, status: 'Active' },
    ]);
    await restore();
    expect(store.registerLocalOnlyDrive).not.toHaveBeenCalled();
  });

  it('does not treat a failed lookup as "not hosted"', async () => {
    vi.mocked(getManagedEnrollments).mockRejectedValue(new Error('offline'));
    await restore();
    expect(store.registerLocalOnlyDrive).not.toHaveBeenCalled();
  });
});
