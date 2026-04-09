import { useEffect, useState, type JSX } from 'react';
import { StoreEvents, type StoreSyncStatus, useStore } from '@tomic/react';
import { FaGlobe } from 'react-icons/fa6';
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

  return (
    <SideBarMenuItem
      icon={
        status.syncInProgress ? (
          <Spinner aria-hidden />
        ) : status.serverConnected ? (
          <FaGlobe title='Connected to server over WebSocket' />
        ) : (
          <OfflineIcon title='Offline / server connection unavailable'>
            <FaGlobe />
          </OfflineIcon>
        )
      }
      label='Sync'
      helper='Inspect sync and connection state'
      path={paths.sync}
      onClick={onClick}
    />
  );
}

const spin = keyframes`
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
`;

const Spinner = styled.span`
  width: 0.9rem;
  height: 0.9rem;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ${spin} 0.8s linear infinite;
`;

const OfflineIcon = styled.span`
  position: relative;
  display: inline-flex;

  &::after {
    content: '';
    position: absolute;
    left: 50%;
    top: -2px;
    width: 2px;
    height: calc(100% + 4px);
    background: currentColor;
    transform: translateX(-50%) rotate(35deg);
    transform-origin: center;
    border-radius: 999px;
  }
`;
