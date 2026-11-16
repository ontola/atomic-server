// @wc-ignore-file
import {
  isLoopbackHost,
  withDeadline,
  type Agent,
  type Store,
} from '@tomic/lib';
import { getManagedEnrollments } from './managed/enrollmentApi';
import { getManagedAccount } from './managed/session';
import {
  getVaultDriveSummary,
  getVaultState,
  listVaultDrives,
} from './managed/vault';
import { fetchNodeDriveUsage } from './managedServer';
import { isOriginWithoutNode } from './originNode';
import { getLocalServerOrigin, isRunningInTauri } from './tauri';

export const BACKUP_DAY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_WEEK_MS = 7 * BACKUP_DAY_MS;
const EVIDENCE_TIMEOUT_MS = 8_000;

export type DriveProtectionSample = {
  vaultHasCopy: boolean;
  /** Time of the last confirmed Vault backup, in Unix milliseconds. */
  lastBackupAt: number | null;
  serverHasCopy: boolean;
  /** Time of the last confirmed full sync with the external server. */
  lastFullSyncAt: number | null;
};

export type DriveProtectionWarning = {
  severity: 'hard' | 'medium';
  missingCopy: boolean;
  age: 'unverified' | 'week-old' | 'day-old';
  source: 'vault' | 'server';
};

export function getDriveProtectionWarning(
  sample: DriveProtectionSample,
  now: number,
): DriveProtectionWarning | null {
  const { vaultHasCopy, serverHasCopy } = sample;
  const missingCopy = !vaultHasCopy && !serverHasCopy;
  const backup = vaultHasCopy ? sample.lastBackupAt : null;
  const fullSync = serverHasCopy ? sample.lastFullSyncAt : null;
  const source =
    serverHasCopy &&
    (backup === null || (fullSync !== null && fullSync > backup))
      ? 'server'
      : 'vault';
  const mostRecent = source === 'server' ? fullSync : backup;

  if (mostRecent === null) {
    return { severity: 'hard', missingCopy, age: 'unverified', source };
  }

  const age = now - mostRecent;

  if (age >= BACKUP_WEEK_MS) {
    return { severity: 'hard', missingCopy, age: 'week-old', source };
  }

  return age > BACKUP_DAY_MS
    ? { severity: 'medium', missingCopy, age: 'day-old', source }
    : null;
}

type VaultEvidence = Pick<
  DriveProtectionSample,
  'vaultHasCopy' | 'lastBackupAt'
>;

const UNVERIFIED_VAULT: VaultEvidence = {
  vaultHasCopy: false,
  lastBackupAt: null,
};

function backupTime(seconds: number | null): number | null {
  return seconds !== null && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : null;
}

async function readVaultEvidence(
  drive: string,
  matchesDrive: (subject: string) => boolean,
): Promise<VaultEvidence> {
  const enrollment = (await listVaultDrives()).find(record =>
    matchesDrive(record.drive_subject),
  );

  if (enrollment) {
    // A paused vault remains readable during its grace period. The state API
    // rejects disabled vaults, and manual Restore works for readable vaults.
    const state = await getVaultState(enrollment.drive_pseudonym);

    if (
      !matchesDrive(state.enrollment.drive_subject) ||
      state.enrollment.status === 'disabled' ||
      !(state.confirmed_objects > 0)
    ) {
      return UNVERIFIED_VAULT;
    }

    return {
      vaultHasCopy: true,
      lastBackupAt: backupTime(state.enrollment.last_backup_at),
    };
  }

  // A collaborator can see another account's confirmation timestamp, but
  // only the payer can read that Vault's object counts.
  const summary = await getVaultDriveSummary(drive);
  const lastBackupAt = summary?.enabled
    ? backupTime(summary.last_backup_at)
    : null;

  return { vaultHasCopy: lastBackupAt !== null, lastBackupAt };
}

function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);

    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // Atomic subjects and incomplete addresses have no HTTP origin.
  }
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

function isExternalServer(url: URL): boolean {
  if (isOriginWithoutNode(url.origin)) return false;
  if (!isRunningInTauri()) return true;
  const embedded = new URL(getLocalServerOrigin());

  return (
    url.origin !== embedded.origin &&
    !(
      isLoopbackHost(url.hostname) &&
      isLoopbackHost(embedded.hostname) &&
      effectivePort(url) === effectivePort(embedded)
    )
  );
}

const fullSyncDates = new WeakMap<Store, Map<string, number>>();
const fullSyncListeners = new Set<() => void>();

function fullSyncKey(store: Store, drive: string, server: URL, agent: string) {
  return JSON.stringify([agent, store.normalizeSubject(drive), server.origin]);
}

export function getLastFullSyncAt(
  store: Store,
  drive: string | undefined,
  serverUrl: string,
  agentSubject: string | undefined,
): number | null {
  const server = httpUrl(serverUrl);

  if (!drive || !server || !agentSubject) return null;

  const date = fullSyncDates
    .get(store)
    ?.get(fullSyncKey(store, drive, server, agentSubject));
  const activeDrive = date === undefined ? undefined : store.getDrive();

  if (
    date === undefined ||
    !activeDrive ||
    store.normalizeSubject(activeDrive) !== store.normalizeSubject(drive) ||
    httpUrl(store.getServerUrl())?.origin !== server.origin ||
    store.getAgent()?.subject !== agentSubject ||
    !store.isLiveSyncedDrive(drive)
  ) {
    return null;
  }

  return date;
}

export function subscribeToFullSync(listener: () => void): () => void {
  fullSyncListeners.add(listener);

  return () => fullSyncListeners.delete(listener);
}

function forgetFullSync(
  store: Store,
  drive: string,
  server: URL,
  agentSubject: string | undefined,
) {
  if (
    agentSubject &&
    fullSyncDates
      .get(store)
      ?.delete(fullSyncKey(store, drive, server, agentSubject))
  ) {
    fullSyncListeners.forEach(listener => listener());
  }
}

/** Check the server's stored versions, including the drive root. A completed
 * handshake can be reported as soon as a push is sent, before it lands. */
async function verifyFullSync(
  store: Store,
  drive: string,
  server: URL,
  agent: Agent,
): Promise<number | null> {
  const socket = store.getDefaultWebSocket();

  if (!socket || !agent.subject) return null;

  const normalizedDrive = store.normalizeSubject(drive);
  const challengeNonce = socket.challengeNonce;

  const isCurrent = () => {
    const status = store.getSyncStatus();

    return (
      store.getAgent() === agent &&
      status.drive !== undefined &&
      store.normalizeSubject(status.drive) === normalizedDrive &&
      httpUrl(status.serverUrl)?.origin === server.origin &&
      store.isLiveSyncedDrive(drive) &&
      !store.isDriveRefusedByServer(drive) &&
      socket === store.getDefaultWebSocket() &&
      socket.challengeNonce === challengeNonce &&
      socket.readyState === WebSocket.OPEN &&
      status.serverConnected &&
      !status.syncInProgress &&
      status.pendingDirtyCount === 0 &&
      status.blockedCount === 0
    );
  };

  if (!isCurrent()) return null;

  const inventory = await socket.driveInventory(drive, '');

  if (!isCurrent()) return null;

  const { vvs } = await store.computeDriveSyncState(drive, { sparse: true });

  if (!vvs || !isCurrent()) return null;

  const remote = new Map(
    inventory.map(({ subject, vv }) => [store.normalizeSubject(subject), vv]),
  );
  const coversLocal =
    remote.has(normalizedDrive) &&
    Object.entries(vvs).every(([subject, version]) => {
      const confirmed = remote.get(store.normalizeSubject(subject));

      return (
        confirmed &&
        Object.entries(version).every(
          ([peer, counter]) => (confirmed[peer] ?? 0) >= counter,
        )
      );
    });

  return coversLocal ? Date.now() : null;
}

/**
 * Read the receipts for this drive. A server can prove it holds resources via
 * a signed usage read. This API reports a replica's presence, without a dated
 * backup of it.
 */
export async function readDriveProtection(
  store: Store,
  drive: string,
  agent: Agent,
  serverUrl: string,
): Promise<DriveProtectionSample> {
  const normalizedDrive = store.normalizeSubject(drive);
  const matchesDrive = (subject: string) =>
    store.normalizeSubject(subject) === normalizedDrive;
  const active = httpUrl(serverUrl);
  const named = httpUrl(drive);
  const localOnly = store.isLocalOnlyDrive(drive);

  if (active && localOnly) {
    forgetFullSync(store, drive, active, agent.subject);
  }

  // A foreign HTTP drive names its own server. A local-only drive does not
  // replicate to the currently selected server.
  const direct =
    named && named.origin !== active?.origin
      ? named
      : localOnly
        ? undefined
        : active;
  const managedAccount = getManagedAccount().catch(() => null);

  const checkedOrigins = new Set<string>();

  const checkServer = async (url: URL | undefined) => {
    if (!url || !isExternalServer(url) || checkedOrigins.has(url.origin)) {
      return undefined;
    }

    checkedOrigins.add(url.origin);
    const usage = await fetchNodeDriveUsage(url.origin, drive, agent).catch(
      () => null,
    );

    if (!usage) return undefined;

    if (usage.enrolled === false || usage.resourceCount === 0) {
      forgetFullSync(store, drive, url, agent.subject);

      return undefined;
    }

    return usage.resourceCount > 0 ? url : undefined;
  };

  const readServerCopy = async () => {
    const confirmed = await checkServer(direct);

    if (confirmed || !(await managedAccount)) return confirmed;

    const enrollments = await getManagedEnrollments().catch(() => []);
    const placement = enrollments.find(
      enrollment =>
        matchesDrive(enrollment.drive_subject) &&
        (enrollment.status === 'Active' || enrollment.status === 'Error') &&
        enrollment.http_origin,
    );

    return checkServer(
      placement?.http_origin ? httpUrl(placement.http_origin) : undefined,
    );
  };

  const readVault = managedAccount.then(account =>
    account ? readVaultEvidence(drive, matchesDrive) : UNVERIFIED_VAULT,
  );
  const serverCopy = readServerCopy();
  const readFullSync = serverCopy.then(server =>
    server && server.origin === active?.origin
      ? verifyFullSync(store, drive, server, agent)
      : null,
  );
  const rememberFullSync = withDeadline(
    readFullSync,
    EVIDENCE_TIMEOUT_MS,
    null,
  ).then(verifiedAt => {
    if (!active || verifiedAt === null || !agent.subject) return;

    const dates = fullSyncDates.get(store) ?? new Map<string, number>();
    const key = fullSyncKey(store, drive, active, agent.subject);

    if (verifiedAt <= (dates.get(key) ?? 0)) return;

    dates.set(key, verifiedAt);
    fullSyncDates.set(store, dates);
    fullSyncListeners.forEach(listener => listener());
  });
  // A slow confirmation should still leave the server copy and Vault visible.
  const [vault, server] = await Promise.all([
    withDeadline(readVault, EVIDENCE_TIMEOUT_MS, UNVERIFIED_VAULT),
    withDeadline(serverCopy, EVIDENCE_TIMEOUT_MS, undefined),
    rememberFullSync,
  ]);

  // Keep an earlier proof through a transient network failure in the same
  // session. A signed response showing the copy is gone clears it above.
  const lastFullSyncAt = getLastFullSyncAt(
    store,
    drive,
    serverUrl,
    agent.subject,
  );

  return {
    ...vault,
    serverHasCopy: !!server || lastFullSyncAt !== null,
    lastFullSyncAt,
  };
}
