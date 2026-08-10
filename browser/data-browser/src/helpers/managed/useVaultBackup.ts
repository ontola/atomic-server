import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentSecretBytes,
  disableVault,
  getVaultState,
  listVaultDrives,
  recoverDriveKey,
  restoreDrive,
  runVaultBackup,
  setUpVaultForDrive,
  type RestoreOutcome,
  type VaultCapableDb,
  type VaultDriveState,
  type VaultEnrollment,
  type VaultKeyOps,
} from './vault';

/**
 * Cloud Vault state for one drive, ready to bind to a UI.
 *
 * The drive key is held in memory for the session and never persisted here.
 * Its durable home is the wrapped envelope on the control plane, which only the
 * account's agent secret opens — so a reload simply fetches and unwraps it
 * again rather than keeping a decrypted copy anywhere a script could reach.
 */
export type VaultStatus =
  | { state: 'loading' }
  | { state: 'unavailable'; reason: string }
  | { state: 'off' }
  | { state: 'on'; enrollment: VaultEnrollment; details: VaultDriveState };

export type UseVaultBackup = {
  status: VaultStatus;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  backupNow: () => Promise<void>;
  restore: () => Promise<RestoreOutcome | null>;
  /** 0–1 while a restore is downloading, otherwise null. */
  restoreProgress: number | null;
};

export function useVaultBackup({
  db,
  keys,
  driveSubject,
  agentSubject,
  agentPrivateKey,
  devicePubkey,
}: {
  db: VaultCapableDb | null;
  keys: VaultKeyOps | null;
  driveSubject: string | null;
  agentSubject: string | null;
  /** The agent's base64 `privateKey`, not the full secret blob. */
  agentPrivateKey: string | null;
  devicePubkey: string | null;
}): UseVaultBackup {
  const [status, setStatus] = useState<VaultStatus>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<number | null>(null);

  // Kept in a ref rather than state: it is not rendered, and putting a key in
  // state would put it in React DevTools for anyone with the page open.
  const driveKey = useRef<Uint8Array | null>(null);

  const ready = Boolean(
    db && keys && driveSubject && agentSubject && agentPrivateKey && devicePubkey,
  );

  const refresh = useCallback(async () => {
    if (!driveSubject) return;

    try {
      const drives = await listVaultDrives();
      const enrollment = drives.find(d => d.drive_subject === driveSubject);

      if (!enrollment) {
        setStatus({ state: 'off' });

        return;
      }

      setStatus({
        state: 'on',
        enrollment,
        details: await getVaultState(enrollment.drive_pseudonym),
      });
    } catch (e) {
      // Not signed in, no portal configured, offline. All of these mean "we
      // cannot say", which is different from "backup is off" — showing an
      // enable button here would produce a confusing failure on click.
      setStatus({ state: 'unavailable', reason: (e as Error).message });
    }
  }, [driveSubject]);

  useEffect(() => {
    if (!ready) {
      setStatus({ state: 'loading' });

      return;
    }

    void refresh();
  }, [ready, refresh]);

  /** Make sure we hold the drive key, fetching and unwrapping if needed. */
  const ensureKey = useCallback(
    async (drivePseudonym: string): Promise<Uint8Array> => {
      if (driveKey.current) return driveKey.current;

      const recovered = await recoverDriveKey({
        keys: keys!,
        drivePseudonym,
        agentSecret: agentSecretBytes(agentPrivateKey!),
      });
      driveKey.current = recovered;

      return recovered;
    },
    [keys, agentPrivateKey],
  );

  /** Run an action with a single busy flag and a readable error. */
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);

      try {
        return await action();
      } catch (e) {
        setError((e as Error).message);

        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const enable = useCallback(async () => {
    await run(async () => {
      const { enrollment, driveKey: key } = await setUpVaultForDrive({
        keys: keys!,
        driveSubject: driveSubject!,
        agentSubject: agentSubject!,
        agentSecret: agentSecretBytes(agentPrivateKey!),
      });
      driveKey.current = key;
      // First backup immediately, so enabling produces something restorable
      // rather than an empty vault waiting on a tick the user cannot see.
      await runVaultBackup({
        db: db!,
        driveSubject: driveSubject!,
        drivePseudonym: enrollment.drive_pseudonym,
        devicePubkey: devicePubkey!,
        driveKey: key,
      });
      await refresh();
    });
  }, [run, keys, driveSubject, agentSubject, agentPrivateKey, db, devicePubkey, refresh]);

  const disable = useCallback(async () => {
    if (status.state !== 'on') return;

    await run(async () => {
      await disableVault(status.enrollment.drive_pseudonym);
      driveKey.current = null;
      await refresh();
    });
  }, [run, status, refresh]);

  const backupNow = useCallback(async () => {
    if (status.state !== 'on') return;

    await run(async () => {
      const key = await ensureKey(status.enrollment.drive_pseudonym);
      await runVaultBackup({
        db: db!,
        driveSubject: driveSubject!,
        drivePseudonym: status.enrollment.drive_pseudonym,
        devicePubkey: devicePubkey!,
        driveKey: key,
      });
      await refresh();
    });
  }, [run, status, ensureKey, db, driveSubject, devicePubkey, refresh]);

  const restore = useCallback(async () => {
    if (status.state !== 'on') return null;

    return run(async () => {
      const key = await ensureKey(status.enrollment.drive_pseudonym);
      setRestoreProgress(0);

      try {
        return await restoreDrive({
          db: db!,
          drivePseudonym: status.enrollment.drive_pseudonym,
          driveKey: key,
          onProgress: (done, total) =>
            setRestoreProgress(total === 0 ? 1 : done / total),
        });
      } finally {
        setRestoreProgress(null);
      }
    });
  }, [run, status, ensureKey, db]);

  return {
    status,
    busy,
    error,
    enable,
    disable,
    backupNow,
    restore,
    restoreProgress,
  };
}
