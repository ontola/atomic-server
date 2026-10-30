import { useEffect, useState, type JSX } from 'react';
import { StoreEvents, type StoreSyncStatus, useStore } from '@tomic/react';
import { FaWifi, FaArrowsRotate, FaCircleExclamation } from 'react-icons/fa6';
import { MdSignalWifiOff } from 'react-icons/md';
import { styled, keyframes } from 'styled-components';
import { currentDriveSync } from '../../helpers/driveSyncStatus';

export type SidebarSyncStatus = StoreSyncStatus & { liveSyncedDrive: boolean };

function sidebarStatus(store: ReturnType<typeof useStore>): SidebarSyncStatus {
  const status = store.getSyncStatus();

  return {
    ...status,
    liveSyncedDrive: !!status.drive && store.isLiveSyncedDrive(status.drive),
  };
}

/** The store's sync status, kept up to date as connection and sync change. */
export function useSyncStatus(): SidebarSyncStatus {
  const store = useStore();
  const [status, setStatus] = useState<SidebarSyncStatus>(() =>
    sidebarStatus(store),
  );

  useEffect(() => {
    const refresh = () => setStatus(sidebarStatus(store));
    const unsubConnection = store.on(StoreEvents.ConnectionChanged, refresh);
    const unsubSync = store.on(StoreEvents.SyncStatusChanged, refresh);
    const unsubAgent = store.on(StoreEvents.AgentChanged, refresh);
    const unsubDrive = store.on(StoreEvents.DriveChanged, refresh);
    const unsubServer = store.on(StoreEvents.ServerURLChanged, refresh);

    return () => {
      unsubAgent();
      unsubConnection();
      unsubSync();
      unsubDrive();
      unsubServer();
    };
  }, [store]);

  return status;
}

export function getSyncIcon(status: SidebarSyncStatus): JSX.Element {
  if (!status.liveSyncedDrive) {
    return (
      <OfflineIcon>
        <FaCircleExclamation title='Not syncing with a server' />
      </OfflineIcon>
    );
  }

  if (!status.serverConnected) {
    return (
      <OfflineIcon>
        <MdSignalWifiOff title='Offline' />
      </OfflineIcon>
    );
  }

  if (status.syncInProgress) {
    return (
      <SpinningIcon aria-hidden>
        <FaArrowsRotate />
      </SpinningIcon>
    );
  }

  if (status.blockedCount > 0) {
    return (
      <WarningIcon>
        <FaCircleExclamation title='Changes could not sync' />
      </WarningIcon>
    );
  }

  if (status.pendingDirtyCount > 0) {
    return (
      <WarningIcon>
        <FaCircleExclamation title='Changes pending' />
      </WarningIcon>
    );
  }

  if (!currentDriveSync(status)) {
    return (
      <WarningIcon>
        <FaCircleExclamation title='Sync not confirmed' />
      </WarningIcon>
    );
  }

  return <FaWifi title='Synced with server' />;
}

/**
 * Whether the sidebar shows its warning icon: changes that could not sync, or
 * that wait with nothing else going on. The Sync page's banner explains it.
 */
export function hasSyncWarning(status: SidebarSyncStatus): boolean {
  return (
    status.liveSyncedDrive &&
    status.serverConnected &&
    !status.syncInProgress &&
    (status.blockedCount > 0 || status.pendingDirtyCount > 0)
  );
}

export function getSyncLabel(status: SidebarSyncStatus): string {
  if (!status.liveSyncedDrive) return 'Not syncing with a server';
  if (!status.serverConnected) return 'Offline';
  if (status.syncInProgress) return 'Syncing...';

  if (status.blockedCount > 0)
    return `${status.blockedCount} changes could not sync (no access)`;

  if (status.pendingDirtyCount > 0)
    return `${status.pendingDirtyCount} changes pending`;

  if (!currentDriveSync(status)) return 'Sync not confirmed';

  return 'Synced with server';
}

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const SpinningIcon = styled.span`
  display: inline-flex;
  animation: ${spin} 1s linear infinite;
`;

const WarningIcon = styled.span`
  color: ${p => p.theme.colors.warning};
  display: inline-flex;
`;

const OfflineIcon = styled.span`
  color: ${p => p.theme.colors.alert};
  display: inline-flex;
`;
