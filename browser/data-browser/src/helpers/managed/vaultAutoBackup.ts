import { StoreEvents, type Store } from '@tomic/lib';
import {
  agentVaultProof,
  getVaultState,
  listVaultDrives,
  recoverDriveKey,
  restoreDrive,
  runVaultBackup,
  setUpVaultForDrive,
  vaultLaneId,
  type BackupOutcome,
  type RestoreOutcome,
  type VaultCapableDb,
  type VaultKeyOps,
} from './vault';
import { loadVaultKeyOps } from './vaultKeyOps';
import { getOrCreateDeviceId } from './devices';
import { getManagedAccount } from './session';
import { nodeVault } from './nodeVault';
import { isRunningInTauri } from '../tauri';

/**
 * Cloud Vault without a button.
 *
 * Every account on a managed origin gets an encrypted backup of its personal
 * drive, free, whether it asked or not. Before this, backup was something a new
 * identity received during onboarding and everyone else had to find on the Sync
 * page — so an account that signed in with its secret on a second browser found
 * nothing, and was told its data lived "on another device". For someone on the
 * free tier there is no other device: the drive is local-only, and the browser
 * profile that made it is the only copy. A backup nobody has to think about is
 * what makes that case answerable.
 *
 * Three moments, one module:
 *
 * - {@link ensureVaultBackup}: enrol the drive (idempotent) and back it up now.
 *   Called at sign-in and at boot, so existing accounts are covered too.
 * - {@link watchForVaultBackups}: back the drive up again a while after the
 *   last edit, and when the tab goes to the background.
 * - {@link restoreFromVault}: pull the backup down on a device that has none of
 *   the data, without a click.
 *
 * All of it is best-effort. The vault needs a control-plane session, the wasm
 * bundle, and a device id; missing any of those makes every call here a quiet
 * no-op rather than an error the user has to read. A workspace with backup
 * switched off is a working workspace; onboarding and sign-in must never block
 * on this.
 */

export type VaultAutoBackupDeps = {
  /** Whether a control-plane session exists. Nothing here works without one. */
  hasAccount: () => Promise<boolean>;
  loadKeys: () => Promise<VaultKeyOps & { proofMessage: Uint8Array }>;
  /** The lane this device writes to, or null when it has no identity yet. */
  laneId: () => Promise<string | null>;
  db: (store: Store) => VaultCapableDb | null;
  setUpVaultForDrive: typeof setUpVaultForDrive;
  runVaultBackup: typeof runVaultBackup;
  listVaultDrives: typeof listVaultDrives;
  getVaultState: typeof getVaultState;
  recoverDriveKey: typeof recoverDriveKey;
  restoreDrive: typeof restoreDrive;
  /** Whether the user switched backup off for this drive on purpose. */
  optedOut: (driveSubject: string) => boolean;
};

const OPT_OUT_KEY = 'atomic.vault.optOut';

/**
 * Drives whose owner turned Cloud Vault off by hand.
 *
 * The control plane cannot tell us: a disabled enrollment is simply absent from
 * the list, exactly like one that never existed, and re-enrolling is how the
 * server implements "enable". So the choice is remembered here — per browser,
 * which is the scope the choice was made in. Without this, every sign-in would
 * switch back on the thing the user just switched off.
 */
function readOptOuts(): Set<string> {
  try {
    const raw = localStorage.getItem(OPT_OUT_KEY);

    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function setVaultOptOut(driveSubject: string, optedOut: boolean): void {
  const drives = readOptOuts();

  if (optedOut) drives.add(driveSubject);
  else drives.delete(driveSubject);

  try {
    localStorage.setItem(OPT_OUT_KEY, JSON.stringify([...drives]));
  } catch {
    // Storage disabled: the choice lasts the session, which is all we can do.
  }
}

export function isVaultOptedOut(driveSubject: string): boolean {
  return readOptOuts().has(driveSubject);
}

const defaultDeps: VaultAutoBackupDeps = {
  // A self-hosted server answers `/api/me` with whatever it likes; that is
  // "no account", not a failure worth logging.
  hasAccount: async () =>
    (await getManagedAccount().catch(() => null)) !== null,
  loadKeys: loadVaultKeyOps,
  laneId: async () => {
    const deviceId = getOrCreateDeviceId();

    return deviceId ? vaultLaneId(deviceId) : null;
  },
  // Same choice `useDriveVault` makes: the desktop and Android apps keep the
  // drive in their embedded node and have no ClientDb.
  db: store => (isRunningInTauri() ? nodeVault : (store.getClientDb() ?? null)),
  setUpVaultForDrive,
  runVaultBackup,
  listVaultDrives,
  getVaultState,
  recoverDriveKey,
  restoreDrive,
  optedOut: isVaultOptedOut,
};

/**
 * Drives this session has enrolled, with their keys.
 *
 * In memory only, for the same reason `useVaultBackup` keeps its key in a ref:
 * the durable copy is the wrapped envelope on the control plane, and a page
 * that persisted the plaintext key would be persisting the one thing the vault
 * is designed never to hold. A reload recovers it by signing the proof message
 * again, which costs one round trip.
 */
const enrolled = new Map<
  string,
  { drivePseudonym: string; driveKey: Uint8Array }
>();

/** Only in tests. */
export function forgetEnrolledVaults(): void {
  enrolled.clear();
}

export type EnsureVaultOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: Error }
  | BackupOutcome;

/**
 * Enrol `driveSubject` in Cloud Vault if it is not yet, and back it up now.
 *
 * Idempotent: the control plane returns the existing enrollment for a drive
 * this account already has, and `setUpVaultForDrive` adopts the stored key
 * rather than minting a second one. So this is safe to call on every sign-in,
 * which is the point — an account that never went through onboarding here gets
 * its backup the next time it signs in.
 *
 * Backs up straight away rather than only enrolling, for the reason
 * onboarding does: an enrollment with nothing in it reports a protection the
 * account does not have.
 */
export function ensureVaultBackup(
  store: Store,
  driveSubject: string,
  deps: VaultAutoBackupDeps = defaultDeps,
): Promise<EnsureVaultOutcome> {
  // Sign-in and the boot watcher both ask for the same drive within the same
  // second. `runVaultBackup` already shares an in-flight pass, but enrolling
  // and unwrapping the key twice is still two round trips for nothing.
  const existing = ensuring.get(driveSubject);

  if (existing) return existing;

  const pass = ensureVaultBackupOnce(store, driveSubject, deps).finally(() => {
    ensuring.delete(driveSubject);
  });
  ensuring.set(driveSubject, pass);

  return pass;
}

const ensuring = new Map<string, Promise<EnsureVaultOutcome>>();

async function ensureVaultBackupOnce(
  store: Store,
  driveSubject: string,
  deps: VaultAutoBackupDeps,
): Promise<EnsureVaultOutcome> {
  const agent = store.getAgent();

  if (!agent?.subject) return { status: 'skipped', reason: 'not signed in' };

  if (deps.optedOut(driveSubject)) {
    return { status: 'skipped', reason: 'backup switched off for this drive' };
  }

  try {
    const db = deps.db(store);
    const lane = await deps.laneId();

    if (!db || !lane) {
      return { status: 'skipped', reason: 'no local database or device id' };
    }

    let known = enrolled.get(driveSubject);

    if (!known) {
      if (!(await deps.hasAccount())) {
        return { status: 'skipped', reason: 'no account session' };
      }

      const keys = await deps.loadKeys();
      const { enrollment, driveKey } = await deps.setUpVaultForDrive({
        keys,
        driveSubject,
        agentSubject: agent.subject,
        // The agent signs a fixed message; its key is never read. That is what
        // keeps non-extractable and hardware-backed keys usable here.
        agentSecret: await agentVaultProof(agent, keys.proofMessage),
      });
      known = { drivePseudonym: enrollment.drive_pseudonym, driveKey };
      enrolled.set(driveSubject, known);
    }

    return await deps.runVaultBackup({
      db,
      driveSubject,
      drivePseudonym: known.drivePseudonym,
      devicePubkey: lane,
      driveKey: known.driveKey,
    });
  } catch (error) {
    // A stale key or enrollment must not be reused after a failure; the next
    // attempt re-derives both from the control plane.
    enrolled.delete(driveSubject);
    console.warn('[cloud-vault] backup failed', error);

    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * How long after the last edit a backup runs.
 *
 * Every pass currently seals the whole drive (incremental export is a
 * follow-up), so this is deliberately not "a few seconds": a burst of typing
 * should cost one upload, not one per pause. Going to the background flushes
 * it early, since a tab that is closing has no later.
 */
export const AUTO_BACKUP_IDLE_MS = 60_000;

export type VaultRestoreOutcome =
  | { status: 'restored'; outcome: RestoreOutcome }
  | { status: 'no-backup'; reason: string }
  | { status: 'failed'; error: Error };

/**
 * Bring `driveSubject` back from its vault, if there is one to bring.
 *
 * `no-backup` covers every case where restoring is not possible rather than
 * broken — no session, no enrollment, an enrollment with nothing confirmed in
 * it — so a caller can fall through to its other routes without showing an
 * error for a device that simply has nothing to restore.
 */
export async function restoreFromVault(
  store: Store,
  driveSubject: string,
  deps: VaultAutoBackupDeps = defaultDeps,
): Promise<VaultRestoreOutcome> {
  const agent = store.getAgent();

  if (!agent?.subject) return { status: 'no-backup', reason: 'not signed in' };

  try {
    const db = deps.db(store);

    if (!db) return { status: 'no-backup', reason: 'no local database' };

    if (!(await deps.hasAccount())) {
      return { status: 'no-backup', reason: 'no account session' };
    }

    const enrollment = (await deps.listVaultDrives()).find(
      e => e.drive_subject === driveSubject && e.status === 'active',
    );

    if (!enrollment) {
      return { status: 'no-backup', reason: 'drive is not backed up' };
    }

    const state = await deps.getVaultState(enrollment.drive_pseudonym);

    // An empty vault restores zero resources, which on screen is
    // indistinguishable from a failed restore.
    if (state.confirmed_objects === 0) {
      return { status: 'no-backup', reason: 'the vault is empty' };
    }

    const keys = await deps.loadKeys();
    const driveKey = await deps.recoverDriveKey({
      keys,
      drivePseudonym: enrollment.drive_pseudonym,
      agentSecret: await agentVaultProof(agent, keys.proofMessage),
    });
    const outcome = await deps.restoreDrive({
      db,
      drivePseudonym: enrollment.drive_pseudonym,
      driveKey,
    });

    // The device now holds the drive and the key; later edits here should go
    // back up without a second enrollment round trip.
    enrolled.set(driveSubject, {
      drivePseudonym: enrollment.drive_pseudonym,
      driveKey,
    });

    return { status: 'restored', outcome };
  } catch (error) {
    console.warn('[cloud-vault] restore failed', error);

    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Keep the open drive backed up as it changes.
 *
 * Listens for the store's own save/remove events — the user's edits, not
 * remote pushes — and runs {@link ensureVaultBackup} for the drive that is open
 * once the edits stop. That drive rather than the edited resource's, because a
 * resource's drive is the root of a parent chain that may not be loaded, and
 * edits happen in the drive on screen in all but contrived cases.
 *
 * Only drives that are local-only, or that this session already enrolled, are
 * backed up from here. A drive on a managed node is synced by that node and
 * needs no second copy; a drive on somebody else's server is not ours to back
 * up at all.
 *
 * Returns the unsubscribe function.
 */
export function watchForVaultBackups(
  store: Store,
  deps: VaultAutoBackupDeps = defaultDeps,
  options: { idleMs?: number; window?: Window | null } = {},
): () => void {
  const idleMs = options.idleMs ?? AUTO_BACKUP_IDLE_MS;
  const win =
    options.window === undefined
      ? typeof window === 'undefined'
        ? null
        : window
      : options.window;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;

  const flush = () => {
    if (timer) clearTimeout(timer);

    timer = undefined;
    const drive = pending;
    pending = undefined;

    if (drive) void ensureVaultBackup(store, drive, deps);
  };

  const schedule = () => {
    const drive = store.getDrive();

    if (!drive) return;
    if (!store.isLocalOnlyDrive(drive) && !enrolled.has(drive)) return;

    pending = drive;

    if (timer) clearTimeout(timer);

    timer = setTimeout(flush, idleMs);
  };

  // A tab going to the background may never come back. The upload is not
  // guaranteed to finish, but a backup that starts has a chance; one scheduled
  // for later has none.
  const onHidden = () => {
    if (win?.document.visibilityState === 'hidden') flush();
  };

  const unsubscribe = [
    store.on(StoreEvents.ResourceSaved, schedule),
    store.on(StoreEvents.ResourceRemoved, schedule),
    store.on(StoreEvents.ResourceManuallyCreated, schedule),
  ];
  win?.document.addEventListener('visibilitychange', onHidden);
  win?.addEventListener('pagehide', flush);

  return () => {
    if (timer) clearTimeout(timer);

    timer = undefined;
    pending = undefined;
    unsubscribe.forEach(off => off());
    win?.document.removeEventListener('visibilitychange', onHidden);
    win?.removeEventListener('pagehide', flush);
  };
}
