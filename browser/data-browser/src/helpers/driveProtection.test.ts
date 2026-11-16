import type { Agent, Store } from '@tomic/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_DAY_MS,
  BACKUP_WEEK_MS,
  getDriveProtectionWarning,
  readDriveProtection,
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
  } as unknown as Store;
}

function signedIn() {
  vi.mocked(getManagedAccount).mockResolvedValue({
    email: 'alice@example.test',
  });
}

describe('drive protection warning', () => {
  it('treats a server replica as a copy without a dated backup', () => {
    expect(getDriveProtectionWarning(inaccessible, NOW)).toEqual({
      severity: 'hard',
      missingCopy: true,
      backup: 'unverified',
    });
    expect(
      getDriveProtectionWarning({ ...inaccessible, serverHasCopy: true }, NOW),
    ).toEqual({
      severity: 'hard',
      missingCopy: false,
      backup: 'unverified',
    });
  });

  it.each([
    [BACKUP_DAY_MS, null],
    [BACKUP_DAY_MS + 1, { severity: 'medium', backup: 'day-old' }],
    [BACKUP_WEEK_MS - 1, { severity: 'medium', backup: 'day-old' }],
    [BACKUP_WEEK_MS, { severity: 'hard', backup: 'week-old' }],
  ])('applies the freshness thresholds at age %s', (age, warning) => {
    const sample = {
      ...inaccessible,
      vaultHasCopy: true,
      lastBackupAt: NOW - age,
    };

    expect(getDriveProtectionWarning(sample, NOW)).toEqual(
      warning && { missingCopy: false, ...warning },
    );
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
