import { useEffect, useState, type JSX } from 'react';
import { StoreEvents, type StoreSyncStatus, useStore } from '@tomic/react';
import { FaWifi, FaArrowsRotate, FaCircleExclamation } from 'react-icons/fa6';
import { MdSignalWifiOff } from 'react-icons/md';
import { styled, keyframes } from 'styled-components';
import { paths } from '../../routes/paths';
import { SideBarMenuItem } from './SideBarMenuItem';

export function SyncMenuItem({
  onClick,
}: {
  onClick?: () => void;
}): JSX.Element {
  const store = useStore();
  const [status, setStatus] = useState<StoreSyncStatus>(() =>
    store.getSyncStatus(),
  );

  useEffect(() => {
    const refresh = () => setStatus(store.getSyncStatus());
    const unsubConnection = store.on(StoreEvents.ConnectionChanged, refresh);
    const unsubSync = store.on(StoreEvents.SyncStatusChanged, next =>
      setStatus(next),
    );
    const unsubDrive = store.on(StoreEvents.DriveChanged, refresh);
    const unsubServer = store.on(StoreEvents.ServerURLChanged, refresh);

    return () => {
      unsubConnection();
      unsubSync();
      unsubDrive();
      unsubServer();
    };
  }, [store]);

  const icon = getSyncIcon(status);
  const label = getSyncLabel(status);

  return (
    <SideBarMenuItem
      icon={icon}
      label='Sync'
      helper={label}
      path={paths.sync}
      onClick={onClick}
    />
  );
}

function getSyncIcon(status: StoreSyncStatus): JSX.Element {
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

  if (status.pendingDirtyCount > 0) {
    return (
      <WarningIcon>
        <FaCircleExclamation title='Changes pending' />
      </WarningIcon>
    );
  }

  return <FaWifi title='Connected' />;
}

function getSyncLabel(status: StoreSyncStatus): string {
  if (!status.serverConnected) return 'Offline';
  if (status.syncInProgress) return 'Syncing...';
  if (status.pendingDirtyCount > 0)
    return `${status.pendingDirtyCount} changes pending`;

  return 'Connected';
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
