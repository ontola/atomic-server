import type { Agent, Store } from '@tomic/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_DAY_MS,
  BACKUP_WEEK_MS,
  getDriveProtectionWarning,
  getLastFullSyncAt,
  readDriveProtection,
  subscribeToFullSync,
} from './driveProtection';
import { getManagedEnrollments } from './managed/enrollmentApi';
import { getManagedAccount } from './managed/session';
import {
  getVaultDriveSummary,
  getVaultState,
  listVaultDrives,
  type VaultEnrollment,
} from './managed/vault';
import { fetchNodeDriveUsage } from './managedServer';
import { isOriginWithoutNode } from './originNode';
import { getLocalServerOrigin, isRunningInTauri } from './tauri';

vi.mock('./managed/enrollmentApi', () => ({ getManagedEnrollments: vi.fn() }));
vi.mock('./managed/session', () => ({ getManagedAccount: vi.fn() }));
vi.mock('./managed/vault', () => ({
  getVaultDriveSummary: vi.fn(),
  getVaultState: vi.fn(),
  listVaultDrives: vi.fn(),
}));
vi.mock('./managedServer', () => ({ fetchNodeDriveUsage: vi.fn() }));
vi.mock('./originNode', () => ({ isOriginWithoutNode: vi.fn() }));
vi.mock('./tauri', () => ({
  getLocalServerOrigin: vi.fn(),
  isRunningInTauri: vi.fn(),
}));

const DRIVE = 'atomic:some-drive';
const AGENT = { subject: 'atomic:agent:alice' } as Agent;
const SERVER = 'https://node.example.test';
const HOSTED = 'https://cloud.example.test';
const PORTAL = 'https://app.example.test';
const NOW = 1_800_000_000_000;

const inaccessible = {
  vaultHasCopy: false,
  lastBackupAt: null,
  serverHasCopy: false,
  lastFullSyncAt: null,
};

const enrollment: VaultEnrollment = {
  id: 'id',
  drive_subject: DRIVE,
  drive_pseudonym: 'vault-pseudonym',
  status: 'active',
  used_bytes: 100,
  quota_bytes: 1000,
  last_backup_at: NOW / 1000,
};

const usage = {
  driveName: 'Workspace',
  resourceCount: 12,
  blobBytes: 20,
  loroBytes: 1000,
  enrolled: true,
};

function store(localOnly = false): Store {
  return {
    normalizeSubject: (subject: string) =>
      subject.replace(/^did:ad:/, 'atomic:'),
    isLocalOnlyDrive: () => localOnly,
    getDefaultWebSocket: () => undefined,
  } as unknown as Store;
}

function connectedStore() {
  const socket = {
    readyState: WebSocket.OPEN,
    driveInventory: vi.fn().mockResolvedValue([
      { subject: 'did:ad:some-drive', vv: { peer: 3 } },
      { subject: 'atomic:child', vv: { peer: 5 } },
    ]),
  };
  const status: Pick<
    ReturnType<Store['getSyncStatus']>,
    | 'drive'
    | 'serverUrl'
    | 'serverConnected'
    | 'syncInProgress'
    | 'pendingDirtyCount'
    | 'blockedCount'
  > = {
    drive: DRIVE,
    serverUrl: SERVER,
    serverConnected: true,
    syncInProgress: false,
    pendingDirtyCount: 0,
    blockedCount: 0,
  };
  const activeStore = Object.assign(store(), {
    getAgent: vi.fn().mockReturnValue(AGENT),
    getDrive: () => status.drive,
    getServerUrl: () => status.serverUrl,
    getDefaultWebSocket: vi.fn().mockReturnValue(socket),
    getSyncStatus: vi.fn().mockReturnValue(status),
    isLiveSyncedDrive: vi.fn().mockReturnValue(true),
    isDriveRefusedByServer: vi.fn().mockReturnValue(false),
    computeDriveSyncState: vi.fn().mockResolvedValue({
      vvs: {
        [DRIVE]: { peer: 3 },
        'atomic:child': { peer: 4 },
      },
    }),
  });

  return { activeStore, status, socket };
}

function signedIn() {
  vi.mocked(getManagedAccount).mockResolvedValue({
    email: 'alice@example.test',
  });
}

describe('drive protection warning', () => {
  it('distinguishes a server copy from a confirmed full sync', () => {
    expect(getDriveProtectionWarning(inaccessible, NOW)).toEqual({
      severity: 'hard',
      missingCopy: true,
      age: 'unverified',
      source: 'vault',
    });
    expect(
      getDriveProtectionWarning({ ...inaccessible, serverHasCopy: true }, NOW),
    ).toEqual({
      severity: 'hard',
      missingCopy: false,
      age: 'unverified',
      source: 'server',
    });
    expect(
      getDriveProtectionWarning(
        { ...inaccessible, serverHasCopy: true, lastFullSyncAt: NOW },
        NOW,
      ),
    ).toBeNull();
  });

  it.each(['vault', 'server'] as const)(
    'applies the freshness thresholds for %s',
    source => {
      for (const [age, warning] of [
        [BACKUP_DAY_MS, null],
        [BACKUP_DAY_MS + 1, { severity: 'medium', age: 'day-old' }],
        [BACKUP_WEEK_MS - 1, { severity: 'medium', age: 'day-old' }],
        [BACKUP_WEEK_MS, { severity: 'hard', age: 'week-old' }],
      ] as const) {
        const sample = {
          ...inaccessible,
          ...(source === 'vault'
            ? { vaultHasCopy: true, lastBackupAt: NOW - age }
            : { serverHasCopy: true, lastFullSyncAt: NOW - age }),
        };

        expect(getDriveProtectionWarning(sample, NOW)).toEqual(
          warning && { source, missingCopy: false, ...warning },
        );
      }
    },
  );

  it('uses the newest confirmed server sync or Vault backup', () => {
    const sample = {
      vaultHasCopy: true,
      lastBackupAt: NOW - BACKUP_WEEK_MS,
      serverHasCopy: true,
      lastFullSyncAt: NOW - BACKUP_DAY_MS - 1,
    };

    expect(getDriveProtectionWarning(sample, NOW)).toEqual({
      severity: 'medium',
      missingCopy: false,
      age: 'day-old',
      source: 'server',
    });
    expect(
      getDriveProtectionWarning({ ...sample, lastBackupAt: NOW }, NOW),
    ).toBeNull();
    expect(
      getDriveProtectionWarning({ ...sample, lastFullSyncAt: NOW }, NOW),
    ).toBeNull();
    expect(
      getDriveProtectionWarning(
        { ...sample, lastBackupAt: sample.lastFullSyncAt },
        NOW,
      )?.source,
    ).toBe('vault');
  });
});

describe('reading drive protection evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getManagedAccount).mockResolvedValue(null);
    vi.mocked(getManagedEnrollments).mockResolvedValue([]);
    vi.mocked(listVaultDrives).mockResolvedValue([]);
    vi.mocked(getVaultDriveSummary).mockResolvedValue({ enabled: false });
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue(null);
    vi.mocked(isOriginWithoutNode).mockImplementation(url => url === PORTAL);
    vi.mocked(isRunningInTauri).mockReturnValue(false);
    vi.mocked(getLocalServerOrigin).mockReturnValue('http://localhost:9883');
  });

  afterEach(() => vi.useRealTimers());

  it.each(['active', 'suspended'])(
    'uses confirmed objects in a readable %s Vault',
    async status => {
      signedIn();
      vi.mocked(listVaultDrives).mockResolvedValue([
        {
          ...enrollment,
          drive_subject: 'did:ad:some-drive',
          last_backup_at: null,
        },
      ]);
      vi.mocked(getVaultState).mockResolvedValue({
        enrollment: { ...enrollment, status },
        confirmed_objects: 2,
        lanes: {},
        checkpoints: [],
        pending_uploads: 1,
      });

      expect(
        await readDriveProtection(store(true), DRIVE, AGENT, PORTAL),
      ).toEqual({
        ...inaccessible,
        vaultHasCopy: true,
        lastBackupAt: NOW,
      });
      expect(fetchNodeDriveUsage).not.toHaveBeenCalled();
    },
  );

  it('does not count an upload reservation or a stale timestamp with no objects', async () => {
    signedIn();
    vi.mocked(listVaultDrives).mockResolvedValue([enrollment]);
    vi.mocked(getVaultState).mockResolvedValue({
      enrollment,
      confirmed_objects: 0,
      lanes: {},
      checkpoints: [],
      pending_uploads: 1,
    });

    expect(
      await readDriveProtection(store(true), DRIVE, AGENT, SERVER),
    ).toEqual(inaccessible);
    expect(fetchNodeDriveUsage).not.toHaveBeenCalled();
  });

  it('uses the confirmed receipt visible to a collaborator', async () => {
    signedIn();
    vi.mocked(getVaultDriveSummary).mockResolvedValue({
      enabled: true,
      is_yours: false,
      suspended: false,
      last_backup_at: NOW / 1000,
      backed_up_by: 'Alex',
    });

    expect(
      await readDriveProtection(store(true), DRIVE, AGENT, PORTAL),
    ).toEqual({
      ...inaccessible,
      vaultHasCopy: true,
      lastBackupAt: NOW,
    });
    expect(getVaultDriveSummary).toHaveBeenCalledWith(DRIVE);
  });

  it('uses signed usage even when the managed account lookup fails', async () => {
    vi.mocked(getManagedAccount).mockRejectedValue(new Error('Offline'));
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);

    expect(await readDriveProtection(store(), DRIVE, AGENT, SERVER)).toEqual({
      ...inaccessible,
      serverHasCopy: true,
    });
    expect(fetchNodeDriveUsage).toHaveBeenCalledWith(SERVER, DRIVE, AGENT);
  });

  it('confirms a full sync with a server holding every local version while Vault is off', async () => {
    vi.useFakeTimers().setSystemTime(NOW);
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);
    const { activeStore, status, socket } = connectedStore();
    const listener = vi.fn();
    const unsubscribe = subscribeToFullSync(listener);

    try {
      const sample = await readDriveProtection(
        activeStore,
        DRIVE,
        AGENT,
        SERVER,
      );

      expect(sample).toEqual({
        ...inaccessible,
        serverHasCopy: true,
        lastFullSyncAt: NOW,
      });
      expect(getDriveProtectionWarning(sample, NOW)).toBeNull();
      expect(socket.driveInventory).toHaveBeenCalledExactlyOnceWith(DRIVE, '');
      expect(getLastFullSyncAt(activeStore, DRIVE, SERVER, AGENT.subject)).toBe(
        NOW,
      );
      expect(
        getLastFullSyncAt(activeStore, DRIVE, HOSTED, AGENT.subject),
      ).toBeNull();
      expect(
        getLastFullSyncAt(activeStore, DRIVE, SERVER, 'atomic:agent:bob'),
      ).toBeNull();
      expect(listener).toHaveBeenCalledOnce();

      // A new edit in flight cannot advance the last confirmed date.
      status.pendingDirtyCount = 1;
      vi.setSystemTime(NOW + BACKUP_DAY_MS + 1);
      const pending = await readDriveProtection(
        activeStore,
        DRIVE,
        AGENT,
        SERVER,
      );
      expect(pending.lastFullSyncAt).toBe(NOW);
      expect(getDriveProtectionWarning(pending, Date.now())).toMatchObject({
        severity: 'medium',
        source: 'server',
      });
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    [{ subject: 'atomic:child', vv: { peer: 5 } }],
    [
      { subject: DRIVE, vv: { peer: 3 } },
      { subject: 'atomic:child', vv: { peer: 3 } },
    ],
  ])(
    'requires the remote root and current local versions',
    async (...inventory) => {
      vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);
      const { activeStore, socket } = connectedStore();
      socket.driveInventory.mockResolvedValue(inventory);

      expect(
        await readDriveProtection(activeStore, DRIVE, AGENT, SERVER),
      ).toEqual({
        ...inaccessible,
        serverHasCopy: true,
      });
    },
  );

  it('discards inventory if the active socket changes while it was requested', async () => {
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);
    const { activeStore, socket } = connectedStore();
    socket.driveInventory.mockImplementationOnce(async () => {
      vi.mocked(activeStore.getDefaultWebSocket).mockReturnValue(undefined);

      return [{ subject: DRIVE, vv: { peer: 3 } }];
    });

    expect(
      await readDriveProtection(activeStore, DRIVE, AGENT, SERVER),
    ).toEqual({
      ...inaccessible,
      serverHasCopy: true,
    });
    expect(activeStore.computeDriveSyncState).not.toHaveBeenCalled();
  });

  it.each([
    { ...usage, enrolled: false },
    { ...usage, resourceCount: 0 },
  ])(
    'ages a previous full sync when the server cannot be reached, and clears it after a signed refusal',
    async lostCopy => {
      vi.useFakeTimers().setSystemTime(NOW);
      vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);
      const { activeStore, status } = connectedStore();

      await readDriveProtection(activeStore, DRIVE, AGENT, SERVER);

      status.serverConnected = false;
      vi.setSystemTime(NOW + BACKUP_WEEK_MS);
      vi.mocked(fetchNodeDriveUsage).mockRejectedValue(new Error('Offline'));
      const offline = await readDriveProtection(
        activeStore,
        DRIVE,
        AGENT,
        SERVER,
      );

      expect(getDriveProtectionWarning(offline, Date.now())).toEqual({
        severity: 'hard',
        missingCopy: false,
        age: 'week-old',
        source: 'server',
      });

      vi.mocked(fetchNodeDriveUsage).mockResolvedValue(lostCopy);

      expect(
        await readDriveProtection(activeStore, DRIVE, AGENT, SERVER),
      ).toEqual(inaccessible);
      expect(
        getLastFullSyncAt(activeStore, DRIVE, SERVER, AGENT.subject),
      ).toBeNull();
    },
  );

  it('keeps a confirmed Vault receipt when the server check times out', async () => {
    vi.useFakeTimers();
    signedIn();
    vi.mocked(listVaultDrives).mockResolvedValue([enrollment]);
    vi.mocked(getVaultState).mockResolvedValue({
      enrollment,
      confirmed_objects: 2,
      lanes: {},
      checkpoints: [],
      pending_uploads: 0,
    });
    vi.mocked(fetchNodeDriveUsage).mockReturnValue(new Promise(() => {}));

    const sample = readDriveProtection(store(), DRIVE, AGENT, SERVER);
    await vi.advanceTimersByTimeAsync(8_000);

    expect(await sample).toEqual({
      ...inaccessible,
      vaultHasCopy: true,
      lastBackupAt: NOW,
    });
  });

  it('keeps confirmed server usage when the Vault check times out', async () => {
    vi.useFakeTimers();
    vi.mocked(getManagedAccount).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);

    const sample = readDriveProtection(store(), DRIVE, AGENT, SERVER);
    await vi.advanceTimersByTimeAsync(8_000);

    expect(await sample).toEqual({ ...inaccessible, serverHasCopy: true });
  });

  it('does not count an external server with no readable resources', async () => {
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue({
      ...usage,
      resourceCount: 0,
    });

    expect(await readDriveProtection(store(), DRIVE, AGENT, SERVER)).toEqual(
      inaccessible,
    );
  });

  it('checks a foreign HTTP drive at its own origin', async () => {
    const foreignDrive = `${HOSTED}/private-drive`;
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);

    expect(
      (await readDriveProtection(store(), foreignDrive, AGENT, SERVER))
        .serverHasCopy,
    ).toBe(true);
    expect(fetchNodeDriveUsage).toHaveBeenCalledExactlyOnceWith(
      HOSTED,
      foreignDrive,
      AGENT,
    );
  });

  it('only treats a matching managed placement as a candidate to verify', async () => {
    signedIn();
    vi.mocked(getManagedEnrollments).mockResolvedValue([
      {
        drive_subject: 'atomic:other',
        agent_subject: AGENT.subject!,
        status: 'Active',
        http_origin: SERVER,
      },
      {
        drive_subject: DRIVE,
        agent_subject: AGENT.subject!,
        status: 'Active',
        http_origin: HOSTED,
      },
    ]);
    vi.mocked(fetchNodeDriveUsage).mockResolvedValue(usage);

    expect(
      (await readDriveProtection(store(true), DRIVE, AGENT, SERVER))
        .serverHasCopy,
    ).toBe(true);
    expect(fetchNodeDriveUsage).toHaveBeenCalledExactlyOnceWith(
      HOSTED,
      DRIVE,
      AGENT,
    );
  });

  it.each([
    'http://localhost:9883',
    'http://127.0.0.1:9883',
    'http://[::1]:9883',
  ])('ignores the embedded Tauri node at %s', async origin => {
    vi.mocked(isRunningInTauri).mockReturnValue(true);

    expect(await readDriveProtection(store(), DRIVE, AGENT, origin)).toEqual(
      inaccessible,
    );
    expect(fetchNodeDriveUsage).not.toHaveBeenCalled();
  });

  it('does not ask the static app origin for a server copy', async () => {
    expect(await readDriveProtection(store(), DRIVE, AGENT, PORTAL)).toEqual(
      inaccessible,
    );
    expect(fetchNodeDriveUsage).not.toHaveBeenCalled();
  });
});
