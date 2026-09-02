import { useEffect } from 'react';
import { useStore } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { deviceHasDriveData } from '../helpers/driveData';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import {
  ensureVaultBackup,
  watchForVaultBackups,
} from '../helpers/managed/vaultAutoBackup';

/**
 * Keeps the signed-in account's personal drive backed up in Cloud Vault while
 * the app is open. Renders nothing.
 *
 * Two jobs. At boot, and whenever the agent changes, it enrols the personal
 * drive and backs it up once — which is how an account that predates automatic
 * backup, or that only ever signs in on this device, gets covered without
 * going through sign-in again. After that it backs the open drive up again a
 * while after each edit. Both are no-ops without a control-plane session, so
 * a self-hosted install pays one failed `/api/me` per sign-in and nothing else.
 */
export function CloudVaultWatcher() {
  const store = useStore();
  const { agent } = useSettings();
  const subject = agent?.subject;

  useEffect(() => watchForVaultBackups(store), [store]);

  useEffect(() => {
    if (!subject || !agent) return;

    let cancelled = false;

    void (async () => {
      const drive = await fetchPrivateDriveSubject(store, agent).catch(
        () => undefined,
      );

      if (cancelled || !drive) return;

      // Nothing to back up from a device that does not hold the drive — and
      // sign-in handles that device by restoring instead.
      if (!(await deviceHasDriveData(store, drive))) return;

      if (!cancelled) void ensureVaultBackup(store, drive);
    })();

    return () => {
      cancelled = true;
    };
    // `agent` is a new object on every settings render; its subject is what
    // identifies a sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, subject]);

  return null;
}
