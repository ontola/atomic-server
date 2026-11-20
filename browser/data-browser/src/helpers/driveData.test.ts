import { describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/lib';
import {
  deviceHasDriveData,
  driveHasServer,
  keepUnhostedRestoreLocal,
} from './driveData';
import { isOriginWithoutNode } from './originNode';
import { getManagedEnrollments } from './managed/enrollmentApi';
import { fetchManagedInfo, EMPTY_NODE_INFO } from './managedServer';

vi.mock('./originNode', () => ({ isOriginWithoutNode: vi.fn() }));
vi.mock('./managed/enrollmentApi', () => ({ getManagedEnrollments: vi.fn() }));
vi.mock('./managedServer', async importOriginal => ({
  ...(await importOriginal<typeof import('./managedServer')>()),
  fetchManagedInfo: vi.fn(),
}));

describe('keepUnhostedRestoreLocal', () => {
  const managedNode = { ...EMPTY_NODE_INFO, managed: true };

  const store = () => ({
    normalizeSubject: (s: string) => s,
    getServerUrl: () => 'https://node1.example',
    registerLocalOnlyDrive: vi.fn(),
  });
  const enrollment = (drive_subject: string, status = 'Active') => ({
    drive_subject,
    status,
    agent_subject: null,
  });

  it.each([
    ['no enrollment', []],
    ['another drive only', [enrollment('did:ad:other')]],
    ['a disabled enrollment', [enrollment('did:ad:drive', 'Disabled')]],
  ])('registers the drive local-only with %s', async (_, list) => {
    vi.mocked(fetchManagedInfo).mockResolvedValue(managedNode);
    vi.mocked(getManagedEnrollments).mockResolvedValue(list);
    const s = store();

    await keepUnhostedRestoreLocal(s as unknown as Store, 'did:ad:drive');
    expect(getManagedEnrollments).toHaveBeenCalledWith(true);
    expect(s.registerLocalOnlyDrive).toHaveBeenCalledWith('did:ad:drive');
  });

  it('leaves a hosted drive on its node', async () => {
    vi.mocked(fetchManagedInfo).mockResolvedValue(managedNode);
    vi.mocked(getManagedEnrollments).mockResolvedValue([
      enrollment('did:ad:drive'),
    ]);
    const s = store();

    await keepUnhostedRestoreLocal(s as unknown as Store, 'did:ad:drive');
    expect(s.registerLocalOnlyDrive).not.toHaveBeenCalled();
  });

  it('does not read a failed lookup as "not hosted"', async () => {
    vi.mocked(fetchManagedInfo).mockResolvedValue(managedNode);
    vi.mocked(getManagedEnrollments).mockRejectedValue(new Error('offline'));
    const s = store();

    await keepUnhostedRestoreLocal(s as unknown as Store, 'did:ad:drive');
    expect(s.registerLocalOnlyDrive).not.toHaveBeenCalled();
  });

  // Enrollments only list Cloud Server hosting. A self-hosted server has none
  // either way, and a server that cannot be asked reads as "not managed" too.
  it('leaves a drive on a non-managed server alone without a confirmed absence', async () => {
    vi.mocked(fetchManagedInfo).mockResolvedValue(EMPTY_NODE_INFO);
    vi.mocked(getManagedEnrollments).mockResolvedValue([]);
    const s = store();

    await keepUnhostedRestoreLocal(s as unknown as Store, 'did:ad:drive');
    expect(s.registerLocalOnlyDrive).not.toHaveBeenCalled();
  });

  it('skips the lookup when the node already said the drive is not there', async () => {
    vi.mocked(getManagedEnrollments).mockClear();
    const s = store();

    await keepUnhostedRestoreLocal(s as unknown as Store, 'did:ad:drive', true);
    expect(getManagedEnrollments).not.toHaveBeenCalled();
    expect(s.registerLocalOnlyDrive).toHaveBeenCalledWith('did:ad:drive');
  });
});

describe('refreshing drive availability', () => {
  it('rechecks an earlier failure after data arrives instead of retaining the miss', async () => {
    vi.mocked(isOriginWithoutNode).mockReturnValue(true);
    let error: Error | undefined = new Error('Not found');
    const store = {
      getServerUrl: () => 'https://app.example',
      isLocalOnlyDrive: () => true,
      getResource: vi.fn(async () => ({ error })),
      getResourceLoading: () => ({ error }),
      reloadResource: vi.fn(async () => {
        error = undefined;
      }),
    };
    const typedStore = store as unknown as Store;
    expect(await deviceHasDriveData(typedStore, 'did:ad:drive')).toBe(false);
    expect(
      await deviceHasDriveData(typedStore, 'did:ad:drive', { refresh: true }),
    ).toBe(true);
  });

  it('does not report an errored resource as available just because the read resolved', async () => {
    const store = {
      getResource: vi
        .fn()
        .mockResolvedValue({ error: new Error('Unauthorized') }),
    };
    expect(
      await deviceHasDriveData(store as unknown as Store, 'did:ad:drive'),
    ).toBe(false);
  });

  it('does not report availability when local storage rejects the read', async () => {
    const store = {
      getResource: vi.fn().mockRejectedValue(new Error('Storage unavailable')),
    };
    expect(
      await deviceHasDriveData(store as unknown as Store, 'did:ad:drive'),
    ).toBe(false);
  });
  it.each([
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])(
    'nodeless=%s localOnly=%s reloadsLocal=%s',
    async (nodeless, localOnly, local) => {
      vi.mocked(isOriginWithoutNode).mockReturnValue(nodeless);
      const store = {
        getServerUrl: () => 'https://app.example',
        isLocalOnlyDrive: () => localOnly,
        reloadResource: vi.fn().mockResolvedValue(undefined),
        fetchResourceFromServer: vi.fn().mockResolvedValue(undefined),
        getResourceLoading: () => ({ error: undefined }),
      };
      expect(
        await deviceHasDriveData(store as unknown as Store, 'did:ad:drive', {
          refresh: true,
        }),
      ).toBe(true);
      expect(store.reloadResource).toHaveBeenCalledTimes(local ? 1 : 0);
      expect(store.fetchResourceFromServer).toHaveBeenCalledTimes(
        local ? 0 : 1,
      );
    },
  );
});

describe('driveHasServer', () => {
  it.each([
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false],
  ])('nodeless=%s localOnly=%s hasServer=%s', (nodeless, localOnly, has) => {
    vi.mocked(isOriginWithoutNode).mockReturnValue(nodeless);
    const store = {
      getServerUrl: () => 'https://app.example',
      isLocalOnlyDrive: () => localOnly,
    };
    expect(driveHasServer(store, 'did:ad:drive')).toBe(has);
  });
});
