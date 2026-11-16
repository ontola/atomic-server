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
};

export type DriveProtectionWarning = {
  severity: 'hard' | 'medium';
  missingCopy: boolean;
  backup: 'unverified' | 'week-old' | 'day-old' | 'recent';
};

export function getDriveProtectionWarning(
  sample: DriveProtectionSample,
  now: number,
): DriveProtectionWarning | null {
  const { lastBackupAt, vaultHasCopy, serverHasCopy } = sample;
  const missingCopy = !vaultHasCopy && !serverHasCopy;
  const age = lastBackupAt === null ? null : now - lastBackupAt;
  const backup =
    age === null
      ? 'unverified'
      : age >= BACKUP_WEEK_MS
        ? 'week-old'
        : age > BACKUP_DAY_MS
          ? 'day-old'
          : 'recent';

  if (missingCopy || backup === 'unverified' || backup === 'week-old') {
    return { severity: 'hard', missingCopy, backup };
  }

  return backup === 'day-old'
    ? { severity: 'medium', missingCopy, backup }
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
  // A foreign HTTP drive names its own server. A local-only drive does not
  // replicate to the currently selected server.
  const direct =
    named && named.origin !== active?.origin
      ? named
      : store.isLocalOnlyDrive(drive)
        ? undefined
        : active;
  const managedAccount = getManagedAccount().catch(() => null);

  const checkedOrigins = new Set<string>();

  const checkServer = async (url: URL | undefined) => {
    if (!url || !isExternalServer(url) || checkedOrigins.has(url.origin)) {
      return false;
    }

    checkedOrigins.add(url.origin);
    const usage = await fetchNodeDriveUsage(url.origin, drive, agent).catch(
      () => null,
    );

    return !!usage && usage.enrolled !== false && usage.resourceCount > 0;
  };

  const readServerCopy = async () => {
    if (await checkServer(direct)) return true;
    if (!(await managedAccount)) return false;

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
  // An unreachable server must not hide the Vault receipt, or vice versa.
  const [vault, serverHasCopy] = await Promise.all([
    withDeadline(readVault, EVIDENCE_TIMEOUT_MS, UNVERIFIED_VAULT),
    withDeadline(readServerCopy(), EVIDENCE_TIMEOUT_MS, false),
  ]);

  return { ...vault, serverHasCopy };
}
