import { subscribeToSetting } from '../runtimeSetting';

type FirstBackupStatus = 'pending' | 'failed';
type FirstBackupRecord = { agentSubject: string; status: FirstBackupStatus };

const STORAGE_PREFIX = 'atomic.vault.firstBackup:';
const STATUS_EVENT = 'atomic:vault-first-backup-status';
const inMemory = new Map<string, FirstBackupRecord | null>();

export const subscribeFirstVaultBackupStatus = subscribeToSetting(STATUS_EVENT);

function read(driveSubject: string): FirstBackupRecord | null {
  if (inMemory.has(driveSubject)) return inMemory.get(driveSubject) ?? null;

  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + driveSubject);

    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(driveSubject: string, record: FirstBackupRecord | null): void {
  const key = STORAGE_PREFIX + driveSubject;

  try {
    if (record) localStorage.setItem(key, JSON.stringify(record));
    else localStorage.removeItem(key);
    inMemory.delete(driveSubject);
  } catch {
    // The notice still works until reload if browser storage rejects writes.
    inMemory.set(driveSubject, record);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(STATUS_EVENT));
  }
}

export function getFirstVaultBackupStatus(
  agentSubject: string,
  driveSubject: string,
): FirstBackupStatus | null {
  const record = read(driveSubject);

  return record?.agentSubject === agentSubject ? record.status : null;
}

export function beginFirstVaultBackup(
  agentSubject: string,
  driveSubject: string,
): void {
  if (getFirstVaultBackupStatus(agentSubject, driveSubject)) return;
  write(driveSubject, { agentSubject, status: 'pending' });
}

export function failFirstVaultBackup(
  agentSubject: string,
  driveSubject: string,
): void {
  if (getFirstVaultBackupStatus(agentSubject, driveSubject) !== 'pending')
    return;
  write(driveSubject, { agentSubject, status: 'failed' });
}

/** Call only once the service confirms a backup. */
export function confirmFirstVaultBackup(
  agentSubject: string,
  driveSubject: string,
): void {
  if (getFirstVaultBackupStatus(agentSubject, driveSubject)) {
    write(driveSubject, null);
  }
}

export function forgetFirstVaultBackup(driveSubject: string): void {
  if (read(driveSubject)) write(driveSubject, null);
}
